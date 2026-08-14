// Guest WebSocket channel: fail-fast (task #58).
//
// The empty-clients SocketProvider returns a null channel and
// WebSocket::create RELEASE_ASSERTs on it, so *some* channel must exist or
// any guest `new WebSocket()` aborts the whole engine (discord.com/login
// dies on its remote-auth gateway socket). This is that channel, and it
// does nothing else: every connection fails immediately, like an
// unreachable server.
//
// Why not a real one: the engine's only network path is the host-fetch
// bridge (BibNetBridge). WS-1 briefly ran a real RFC 6455 client over
// CurlStream, but that needed the whole curl/TLS transport tier plus a
// host-side wisp dispatcher, which only ever existed in the dev harness —
// in the extension guest WS failed anyway. The curl tier is gone; the
// future path is an engine-side channel over a HOST WebSocket, which will
// reuse WebCore's WebSocketHandshake/Frame/DeflateFramer (still compiled)
// and replace this class, not the BibSocketProvider wiring.
//
// Shape of the failure: connect() reports KO, which makes WebSocket
// failAsynchronously() — a queued task that fires `error` and stops the
// socket. Nothing is delivered from inside the WebSocket constructor.

#pragma once

#include "Document.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "ThreadableWebSocketChannel.h"
#include "WebSocketChannelClient.h"
#include <JavaScriptCore/ArrayBuffer.h>
#include <JavaScriptCore/ConsoleTypes.h>
#include <wtf/Ref.h>
#include <wtf/RefCounted.h>
#include <wtf/WeakPtr.h>
#include <wtf/text/CString.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/WTFString.h>

namespace BIB {

class BibWebSocketChannel final : public RefCounted<BibWebSocketChannel>, public WebCore::ThreadableWebSocketChannel {
public:
    static Ref<BibWebSocketChannel> create(WebCore::Document& document, WebCore::WebSocketChannelClient& client)
    {
        return adoptRef(*new BibWebSocketChannel(document, client));
    }

    // AbstractRefCounted (via ThreadableWebSocketChannel) — same idiom as
    // WorkerThreadableWebSocketChannel.
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    ConnectStatus connect(const URL& url, const String&) final
    {
        if (RefPtr document = m_document.get()) {
            document->addConsoleMessage(JSC::MessageSource::Network, JSC::MessageLevel::Error,
                makeString("WebSocket connection to "_s, url.stringCenterEllipsizedToLength(), " failed: WebSockets are not supported in this browser engine"_s));
        }
        return ConnectStatus::KO;
    }

    String subprotocol() final { return emptyString(); }
    String extensions() final { return emptyString(); }

    void send(CString&&) final { }
    void send(const JSC::ArrayBuffer&, unsigned, unsigned) final { }
    void send(WebCore::Blob&) final { }

    void close(int, const String&) final { }
    void fail(String&&) final { }
    void disconnect() final { m_client = nullptr; }

    void suspend() final { }
    void resume() final { }

    WebCore::WebSocketChannelIdentifier progressIdentifier() const final { return m_progressIdentifier; }
    bool hasCreatedHandshake() const final { return false; }
    bool isConnected() const final { return false; }

    WebCore::ResourceRequest clientHandshakeRequest(const CookieGetter&) const final { return { }; }
    const WebCore::ResourceResponse& serverHandshakeResponse() const final { return m_serverHandshakeResponse; }

private:
    BibWebSocketChannel(WebCore::Document& document, WebCore::WebSocketChannelClient& client)
        : m_document(document)
        , m_client(client)
        , m_progressIdentifier(WebCore::WebSocketChannelIdentifier::generate())
    {
    }

    WeakPtr<WebCore::Document, WebCore::WeakPtrImplWithEventTargetData> m_document;
    ThreadSafeWeakPtr<WebCore::WebSocketChannelClient> m_client;
    WebCore::WebSocketChannelIdentifier m_progressIdentifier;
    WebCore::ResourceResponse m_serverHandshakeResponse;
};

} // namespace BIB
