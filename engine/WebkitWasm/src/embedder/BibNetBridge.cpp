// Host-fetch network bridge implementation. See BibNetBridge.h.
//
// Wire format (browsception bib_abi.h):
//   engine -> page: Module.bibNetBegin(jsonPtr)  — malloc'd UTF-8 JSON
//     { id, method, url, headers: [[k,v],...], bodyPtr, bodyLen }
//     (JS copies body out of the shared heap, then frees both pointers)
//   engine -> page: Module.bibNetCancel(id), Module.bibNetAck(id, bytes)
//   page -> engine: bib_net_response(id, headersJson)   [ownership -> engine]
//                   bib_net_data(id, bytes, len)        [ownership -> engine]
//                   bib_net_done(id, metricsJson|0)
//                   bib_net_fail(id, kind, msg|0)
//                   bib_net_redirect(id, status, headersJson)
//   headersJson: { status, statusText, url, headers: [[k,v],...] }
//     (set-cookie entries appear as individual pairs, captured host-side)

#include "config.h"

#include "BibNetBridge.h"

#include "BibMediaPlayer.h" // BIB::onEngineThread / BIB::proxyToEngine
#include "FormData.h"
#include "HTTPHeaderMap.h"
#include "HTTPHeaderNames.h"
#include "HTTPParsers.h"
#include <emscripten.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/StringToIntegerConversion.h>

namespace BIB {

using namespace WebCore;

static HashMap<int, NetBridgeClient*>& netClientRegistry()
{
    static NeverDestroyed<HashMap<int, NetBridgeClient*>> registry;
    return registry.get();
}

static char* mallocUTF8(const String& string)
{
    CString utf8 = string.utf8();
    char* buffer = static_cast<char*>(malloc(utf8.length() + 1));
    memcpy(buffer, utf8.data(), utf8.length());
    buffer[utf8.length()] = '\0';
    return buffer;
}

int netBridgeStart(NetBridgeClient& client, const ResourceRequest& request, bool isTopLevelDocument)
{
    ASSERT(onEngineThread());
    static int s_nextRequestId = 0;
    int id = ++s_nextRequestId;
    netClientRegistry().set(id, &client);

    auto root = JSON::Object::create();
    root->setInteger("id"_s, id);
    root->setString("method"_s, request.httpMethod());
    root->setString("url"_s, request.url().string());
    if (isTopLevelDocument)
        root->setInteger("main"_s, 1); // 2.4 boundary policy applies host-side

    auto headers = JSON::Array::create();
    for (const auto& field : request.httpHeaderFields()) {
        auto pair = JSON::Array::create();
        pair->pushString(field.key);
        pair->pushString(field.value);
        headers->pushArray(WTF::move(pair));
    }
    root->setArray("headers"_s, WTF::move(headers));

    // Flatten the body into the shared heap. File-backed form parts resolve
    // against MEMFS (usually empty) — documented gap until upload lands.
    char* bodyPtr = nullptr;
    size_t bodyLen = 0;
    if (RefPtr body = request.httpBody()) {
        Vector<uint8_t> flat = body->flatten();
        if (!flat.isEmpty()) {
            bodyLen = flat.size();
            bodyPtr = static_cast<char*>(malloc(bodyLen));
            memcpy(bodyPtr, flat.span().data(), bodyLen);
        }
    }
    root->setInteger("bodyPtr"_s, reinterpret_cast<intptr_t>(bodyPtr));
    root->setInteger("bodyLen"_s, static_cast<int>(bodyLen));

    char* json = mallocUTF8(root->toJSONString());
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.bibNetBegin) {
            Module.bibNetBegin($0);
        } else {
            // No host bridge installed: fail the request instead of hanging.
            Module._bib_wasm_free($0);
            if ($2) Module._bib_wasm_free($2);
            Module._bib_net_fail($1, 2 /* NetErrNetwork */, 0);
        }
    }, json, id, bodyPtr);
    return id;
}

void netBridgeCancel(int id)
{
    ASSERT(onEngineThread());
    if (!netClientRegistry().remove(id))
        return;
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.bibNetCancel) Module.bibNetCancel($0);
    }, id);
}

static void netBridgeAck(int id, int bytes)
{
    MAIN_THREAD_ASYNC_EM_ASM({
        if (Module.bibNetAck) Module.bibNetAck($0, $1);
    }, id, bytes);
}

// Build a ResourceResponse (+ per-value set-cookie list) from headersJson.
// Mirrors what ResourceResponse's CurlResponse constructor derives: header
// map, MIME type, charset, expected length.
static bool parseBridgeResponse(const String& json, ResourceResponse& response, Vector<String>& setCookies)
{
    auto value = JSON::Value::parseJSON(json);
    if (!value)
        return false;
    auto object = value->asObject();
    if (!object)
        return false;

    response.setURL(URL { { }, object->getString("url"_s) });
    response.setHTTPStatusCode(object->getInteger("status"_s).value_or(0));
    auto statusText = object->getString("statusText"_s);
    if (!statusText.isNull())
        response.setHTTPStatusText(WTF::move(statusText));

    if (auto headers = object->getArray("headers"_s)) {
        for (unsigned i = 0; i < headers->length(); i++) {
            auto pair = headers->get(i)->asArray();
            if (!pair || pair->length() != 2)
                continue;
            String name = pair->get(0)->asString();
            String headerValue = pair->get(1)->asString();
            if (name.isNull() || headerValue.isNull())
                continue;
            if (equalLettersIgnoringASCIICase(name, "set-cookie"_s))
                setCookies.append(headerValue);
            response.addHTTPHeaderField(name, headerValue);
        }
    }

    String contentType = response.httpHeaderField(HTTPHeaderName::ContentType);
    response.setMimeType(extractMIMETypeFromMediaType(contentType).convertToASCIILowercase());
    response.setTextEncodingName(extractCharsetFromMediaType(contentType).toString());
    response.setExpectedContentLength(
        parseInteger<long long>(response.httpHeaderField(HTTPHeaderName::ContentLength)).value_or(-1));
    return true;
}

} // namespace BIB

// ---------------------------------------------------------------------------
// Exports (page -> engine). Same self-proxy shape as bib_media_event: run
// direct on the engine thread, else heap-pack the args and queue. Pointer
// args are owned by the engine from the moment the export is entered (the
// page never frees them).

using BIB::NetBridgeClient;

namespace {

struct BibNetJsonTask {
    int id;
    char* json; // malloc'd, freed after dispatch
    int status; // redirect only
};

struct BibNetDataTask {
    int id;
    char* bytes;
    int len;
};

struct BibNetFailTask {
    int id;
    int kind;
    char* message; // may be null
};

} // namespace

extern "C" {

static void bibRunNetResponse(void* p)
{
    auto* task = static_cast<BibNetJsonTask*>(p);
    WebCore::ResourceResponse response;
    Vector<String> setCookies;
    bool ok = BIB::parseBridgeResponse(String::fromUTF8(task->json), response, setCookies);
    free(task->json);
    if (ok) {
        if (auto* client = BIB::netClientRegistry().get(task->id))
            client->netDidReceiveResponse(WTF::move(response), WTF::move(setCookies));
    } else if (auto* client = BIB::netClientRegistry().take(task->id))
        client->netDidFail(BIB::NetErrProtocol, "malformed bridge response"_s);
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_net_response(int id, char* headersJson)
{
    auto* task = new BibNetJsonTask { id, headersJson, 0 };
    if (BIB::onEngineThread())
        return bibRunNetResponse(task);
    if (!BIB::proxyToEngine(bibRunNetResponse, task)) {
        free(task->json);
        delete task;
    }
}

static void bibRunNetData(void* p)
{
    auto* task = static_cast<BibNetDataTask*>(p);
    if (auto* client = BIB::netClientRegistry().get(task->id)) {
        client->netDidReceiveData({ reinterpret_cast<const uint8_t*>(task->bytes), static_cast<size_t>(task->len) });
        BIB::netBridgeAck(task->id, task->len);
    }
    free(task->bytes);
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_net_data(int id, char* bytes, int len)
{
    auto* task = new BibNetDataTask { id, bytes, len };
    if (BIB::onEngineThread())
        return bibRunNetData(task);
    if (!BIB::proxyToEngine(bibRunNetData, task)) {
        free(task->bytes);
        delete task;
    }
}

static void bibRunNetDone(void* p)
{
    auto* task = static_cast<BibNetJsonTask*>(p);
    free(task->json); // metrics unused for now
    if (auto* client = BIB::netClientRegistry().take(task->id))
        client->netDidComplete();
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_net_done(int id, char* metricsJson)
{
    auto* task = new BibNetJsonTask { id, metricsJson, 0 };
    if (BIB::onEngineThread())
        return bibRunNetDone(task);
    if (!BIB::proxyToEngine(bibRunNetDone, task)) {
        free(task->json);
        delete task;
    }
}

static void bibRunNetFail(void* p)
{
    auto* task = static_cast<BibNetFailTask*>(p);
    String message = task->message ? String::fromUTF8(task->message) : String();
    free(task->message);
    if (auto* client = BIB::netClientRegistry().take(task->id))
        client->netDidFail(static_cast<BIB::NetErrorKind>(task->kind), WTF::move(message));
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_net_fail(int id, int kind, char* messageUtf8)
{
    auto* task = new BibNetFailTask { id, kind, messageUtf8 };
    if (BIB::onEngineThread())
        return bibRunNetFail(task);
    if (!BIB::proxyToEngine(bibRunNetFail, task)) {
        free(task->message);
        delete task;
    }
}

static void bibRunNetRedirect(void* p)
{
    auto* task = static_cast<BibNetJsonTask*>(p);
    WebCore::ResourceResponse response;
    Vector<String> setCookies;
    bool ok = BIB::parseBridgeResponse(String::fromUTF8(task->json), response, setCookies);
    free(task->json);
    if (auto* client = BIB::netClientRegistry().take(task->id)) {
        if (ok)
            client->netDidReceiveRedirect(WTF::move(response), WTF::move(setCookies));
        else
            client->netDidFail(BIB::NetErrProtocol, "malformed bridge redirect"_s);
    }
    delete task;
}

EMSCRIPTEN_KEEPALIVE void bib_net_redirect(int id, int status, char* headersJson)
{
    auto* task = new BibNetJsonTask { id, headersJson, status };
    if (BIB::onEngineThread())
        return bibRunNetRedirect(task);
    if (!BIB::proxyToEngine(bibRunNetRedirect, task)) {
        free(task->json);
        delete task;
    }
}

} // extern "C"
