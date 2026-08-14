// PlatformStrategies for the embedder. WebCore requires one to be installed
// before any load completes (FrameLoader::pageLoadCompleted and
// CachedResourceLoader::servePendingRequests dereference the loader strategy
// unconditionally).
//
// browsception 1.2b: the network transport is the HOST-FETCH BRIDGE
// (BibNetBridge.h) — the trusted shim on the host page performs every HTTP(S)
// load. It is the engine's ONLY transport (the curl/TLS tier is gone). Shape:
//   loadResource -> SubresourceLoader::create -> BibResourceLoad
//   BibNetBridge callbacks -> ResourceLoader::didReceiveResponse /
//   didReceiveBuffer / didFinishLoading / didFail — the same public feeding
//   interface WebKit2's WebResourceLoader uses.
// Redirects are engine-driven: the host reports the raw 3xx and this file's
// redirect policy (the NetworkDataTaskCurl recipe, unchanged) issues the
// next hop as a fresh bridge request. Set-Cookie values arrive as a
// per-value list captured host-side (invisible to host fetch()).
// data: URLs go through loader->start(), which handles them before the
// ResourceHandle path (unreachable on a USE(CURL) port).
//
// Cookies: ONE in-memory NetworkStorageSession (CookieJarDB ":memory:")
// shared by the DOM CookieJar (installed on PageConfiguration in main.cpp)
// and the network path here (Cookie request header + Set-Cookie response
// storage — the NetworkDataTaskCurl recipe). Cookies survive in-engine
// navigations but not a host-page reload; OPFS persistence is later work.
//
// Not yet implemented (documented gaps, revisit with auth work):
// HTTP auth challenges (401 renders as the error body), sync XHR,
// ping loads, preconnect.

#include "config.h"

#include "BibNetBridge.h"
#include "BlobRegistry.h"
#include "BlobRegistryImpl.h"
#include "CachedResource.h"
#include "CookieJar.h"
#include "DocumentLoader.h"
#include "FrameLoader.h"
#include "LocalFrame.h"
#include "CookieJarDB.h"
#include "HTTPHeaderNames.h"
#include "LoaderStrategy.h"
#include "MediaStrategy.h"
#include "NetworkLoadMetrics.h"
#include "NetworkStateNotifier.h"
#include "NetworkStorageSession.h"
#include "PasteboardStrategy.h"
#include "PlatformStrategies.h"
#include "ResourceError.h"
#include "ResourceLoader.h"
#include "ResourceLoaderIdentifier.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SameSiteInfo.h"
#include "SharedBuffer.h"
#include "ShouldRelaxThirdPartyCookieBlocking.h"
#include "StorageSessionProvider.h"
#include "SubresourceLoader.h"
#include "UserAgent.h"
#include <pal/SessionID.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>

namespace BIB {

using namespace WebCore;

static const String& embedderErrorDomain()
{
    static NeverDestroyed<String> domain { "BrowserInBrowserEmbedder"_s };
    return domain;
}

// The single cookie store for the whole embedder. Default-session semantics
// (matches the Page's PAL::SessionID::defaultSessionID()), but the database
// is forced to sqlite ":memory:" — the default-session path would be a MEMFS
// file that vanishes on host-page reload anyway, so skip the FS entirely.
NetworkStorageSession& embedderStorageSession()
{
    static NetworkStorageSession* session = [] {
        auto* session = new NetworkStorageSession(PAL::SessionID::defaultSessionID());
        session->setCookieDatabase(makeUniqueRef<CookieJarDB>(":memory:"_s));
        return session;
    }();
    return *session;
}

// DOM-side bridge: main.cpp hands this to CookieJar::create() on the
// PageConfiguration, replacing pageConfigurationWithEmptyClients'
// EmptyStorageSessionProvider (null session = document.cookie no-ops =
// Google's "Cookies are disabled" page).
class EmbedderStorageSessionProvider final : public StorageSessionProvider {
public:
    static Ref<EmbedderStorageSessionProvider> create() { return adoptRef(*new EmbedderStorageSessionProvider); }

private:
    NetworkStorageSession* storageSession() const final { return &embedderStorageSession(); }
};

Ref<WebCore::StorageSessionProvider> createEmbedderStorageSessionProvider()
{
    return EmbedderStorageSessionProvider::create();
}

// Cookie attach shared by document loads (BibResourceLoad) and pings —
// the NetworkDataTaskCurl::appendCookieHeader recipe.
static void appendEmbedderCookieHeader(ResourceRequest& request)
{
    auto includeSecureCookies = request.url().protocolIs("https"_s) ? IncludeSecureCookies::Yes : IncludeSecureCookies::No;
    auto cookieHeaderField = embedderStorageSession().cookieRequestHeaderFieldValue(request.firstPartyForCookies(), SameSiteInfo::create(request), request.url(), std::nullopt, std::nullopt, includeSecureCookies, ApplyTrackingPrevention::Yes, ShouldRelaxThirdPartyCookieBlocking::No, IsKnownCrossSiteTracker::No).first;
    if (!cookieHeaderField.isEmpty())
        request.addHTTPHeaderField(HTTPHeaderName::Cookie, cookieHeaderField);
}

// Store one response's Set-Cookie values (per-value list from the bridge) —
// the NetworkDataTaskCurl::handleCookieHeaders recipe. Runs on EVERY
// response, including 3xx: login/consent flows set cookies on redirect legs.
static void storeBridgeCookies(const URL& firstParty, const URL& responseURL, const Vector<String>& setCookies)
{
    for (const auto& setCookieString : setCookies)
        embedderStorageSession().setCookiesFromHTTPResponse(firstParty, responseURL, setCookieString);
}

// Fire-and-forget ping (navigator.sendBeacon, <a ping>, CSP reports): a
// minimal bridge client that owns itself for one request's lifetime.
// The BibResourceLoad machinery needs a ResourceLoader; pings have none by
// design. Headers are enough — we finish on response (no body read) and
// don't follow redirects (rare for beacon endpoints; documented gap).
class BibPingLoad final : public RefCounted<BibPingLoad>, public BIB::NetBridgeClient {
public:
    static void start(ResourceRequest&& request, LoaderStrategy::PingLoadCompletionHandler&& completionHandler)
    {
        Ref ping = adoptRef(*new BibPingLoad(WTF::move(completionHandler)));
        ping->m_selfRef = ping.copyRef(); // released in finish()
        if (request.httpUserAgent().isEmpty())
            request.setHTTPUserAgent(standardUserAgent());
        appendEmbedderCookieHeader(request);
        ping->m_firstParty = request.firstPartyForCookies();
        ping->m_requestId = netBridgeStart(ping.get(), request);
    }

private:
    explicit BibPingLoad(LoaderStrategy::PingLoadCompletionHandler&& completionHandler)
        : m_completionHandler(WTF::move(completionHandler))
    {
    }

    void finish(const ResourceError& error)
    {
        if (auto handler = std::exchange(m_completionHandler, nullptr))
            handler(error, m_response);
        if (int id = std::exchange(m_requestId, 0))
            BIB::netBridgeCancel(id);
        m_selfRef = nullptr;
    }

    void netDidReceiveResponse(ResourceResponse&& response, Vector<String>&& setCookies) final
    {
        Ref protectedThis { *this }; // finish() drops the self-ref mid-call
        m_response = WTF::move(response);
        storeBridgeCookies(m_firstParty, m_response.url(), setCookies);
        finish({ });
    }

    void netDidReceiveData(std::span<const uint8_t>) final { }
    void netDidComplete() final
    {
        m_requestId = 0;
        finish({ });
    }
    void netDidFail(BIB::NetErrorKind kind, String&& message) final
    {
        m_requestId = 0;
        finish(ResourceError(embedderErrorDomain(), kind, m_response.url(), message));
    }
    void netDidReceiveRedirect(ResourceResponse&& response, Vector<String>&& setCookies) final
    {
        m_requestId = 0;
        storeBridgeCookies(m_firstParty, response.url(), setCookies);
        finish({ }); // don't follow (documented gap; delivery is what matters)
    }

    LoaderStrategy::PingLoadCompletionHandler m_completionHandler;
    RefPtr<BibPingLoad> m_selfRef;
    int m_requestId { 0 };
    URL m_firstParty;
    ResourceResponse m_response;
};

// Drives ONE ResourceLoader through one (or, across redirects, several)
// bridge requests. A stripped-down NetworkDataTaskCurl on a host-fetch
// transport: no credential storage, no downloads, no auth restarts. Cookies
// use the NetworkDataTaskCurl recipe against embedderStorageSession().
class BibResourceLoad final : public RefCounted<BibResourceLoad>, public BIB::NetBridgeClient {
public:
    static Ref<BibResourceLoad> create(ResourceLoader& loader, bool isTopLevelDocument, Function<void(BibResourceLoad&)>&& doneCallback)
    {
        return adoptRef(*new BibResourceLoad(loader, isTopLevelDocument, WTF::move(doneCallback)));
    }

    ResourceLoader* loader() const { return m_loader.get(); }

    void start()
    {
        startBridgeRequest(ResourceRequest { m_loader->request() });
    }

    // Idempotent; also reached re-entrantly via LoaderStrategy::remove()
    // when didFinishLoading/didFail release the loader's resources.
    void cancel()
    {
        m_loader = nullptr;
        if (int id = std::exchange(m_requestId, 0))
            BIB::netBridgeCancel(id);
    }

private:
    BibResourceLoad(ResourceLoader& loader, bool isTopLevelDocument, Function<void(BibResourceLoad&)>&& doneCallback)
        : m_loader(&loader)
        , m_isTopLevelDocument(isTopLevelDocument)
        , m_doneCallback(WTF::move(doneCallback))
    {
    }

    // Initial load and every redirect hop both come through here; the
    // ResourceLoader's own request never carries the Cookie header, so hops
    // can't accumulate stale Cookie values (NetworkDataTaskCurl recipe).
    void startBridgeRequest(ResourceRequest&& request)
    {
        // No FrameLoaderClient supplies a UA on this embedder; sites
        // misbehave badly with an empty one.
        if (request.httpUserAgent().isEmpty())
            request.setHTTPUserAgent(standardUserAgent());
        appendEmbedderCookieHeader(request);
        m_firstParty = request.firstPartyForCookies();
        m_responseCompleted = false;
        m_pendingComplete = false;
        m_queuedBuffers.clear();
        // browsception 2.4: top-level document requests carry "main":1 so
        // the host bridge can apply its sandboxed->native boundary policy
        // (redirect hops re-enter here, so every hop keeps the flag).
        m_requestId = netBridgeStart(*this, request, m_isTopLevelDocument);
    }

    void notifyDone()
    {
        if (auto doneCallback = std::exchange(m_doneCallback, nullptr))
            doneCallback(*this);
    }

    bool shouldRedirect() const
    {
        auto statusCode = m_response.httpStatusCode();
        if (statusCode < 300 || statusCode >= 400)
            return false;
        // Some 3xx status codes aren't actually redirects.
        if (statusCode == 300 || statusCode == 304 || statusCode == 305 || statusCode == 306)
            return false;
        return !m_response.httpHeaderField(HTTPHeaderName::Location).isEmpty();
    }

    bool shouldRedirectAsGET(const ResourceRequest& request, bool crossOrigin) const
    {
        if (request.httpMethod() == "GET"_s || request.httpMethod() == "HEAD"_s)
            return false;
        if (!request.url().protocolIsInHTTPFamily())
            return true;
        if (m_response.isSeeOther())
            return true;
        if ((m_response.isMovedPermanently() || m_response.isFound()) && (request.httpMethod() == "POST"_s))
            return true;
        if (crossOrigin && (request.httpMethod() == "DELETE"_s))
            return true;
        return false;
    }

    void performRedirect()
    {
        static const int maxRedirects = 20;
        if (m_redirectCount++ > maxRedirects) {
            didFailInternal(ResourceError(embedderErrorDomain(), 0, m_response.url(), "Too many redirects"_s));
            return;
        }

        URL redirectedURL { m_response.url(), m_response.httpHeaderField(HTTPHeaderName::Location) };
        // A remote response must never redirect into the local (MEMFS)
        // filesystem (matches NetworkDataTaskCurl::willPerformHTTPRedirection).
        // The host shim refuses non-http(s) fetches anyway; refuse first.
        if (!redirectedURL.protocolIsInHTTPFamily()) {
            didFailInternal(ResourceError(embedderErrorDomain(), 0, m_response.url(), "Redirect to unsupported scheme"_s));
            return;
        }
        ResourceRequest request = m_loader->request();
        if (!redirectedURL.hasFragmentIdentifier() && request.url().hasFragmentIdentifier())
            redirectedURL.setFragmentIdentifier(request.url().fragmentIdentifier());

        bool isCrossOrigin = !protocolHostAndPortAreEqual(request.url(), redirectedURL);
        request.setURL(WTF::move(redirectedURL));

        if (!equalLettersIgnoringASCIICase(request.httpMethod(), "get"_s)) {
            if (!request.url().protocolIsInHTTPFamily() || shouldRedirectAsGET(request, isCrossOrigin)) {
                request.setHTTPMethod("GET"_s);
                request.setHTTPBody(nullptr);
                request.clearHTTPContentType();
            }
        }

        request.removeCredentials();
        if (isCrossOrigin) {
            request.clearHTTPAuthorization();
            request.clearHTTPOrigin();
        }

        ResourceResponse redirectResponse { m_response };
        // First-party-for-cookies on main-frame redirects is updated INSIDE
        // this call: SubresourceLoader -> CachedRawResource::redirectReceived
        // -> DocumentLoader::willSendRequest does
        // setFirstPartyForCookies(newURL) for the main frame (subframes
        // keep the main document's first party, per spec). The cookie
        // attach on the next bridge request therefore sees the updated
        // value (Codex 2026-06-10 — verified, no fork from upstream).
        m_loader->willSendRequest(WTF::move(request), redirectResponse, [this, protectedThis = Ref { *this }](ResourceRequest&& newRequest) {
            if (newRequest.isNull() || !m_loader) {
                // Policy/CSP cancelled the redirect. The loader tears itself
                // down separately; nothing is in flight on the bridge (the
                // 3xx was terminal for the previous request id).
                notifyDone();
                return;
            }
            startBridgeRequest(WTF::move(newRequest));
        });
    }

    void didFailInternal(const ResourceError& error)
    {
        RefPtr loader = m_loader;
        notifyDone(); // removes the registry ref; didFail re-enters remove() harmlessly
        if (loader)
            loader->didFail(error);
    }

    // NetBridgeClient — all callbacks arrive on the engine thread via the
    // export proxy queue, strictly ordered per request id.
    void netDidReceiveResponse(ResourceResponse&& response, Vector<String>&& setCookies) final
    {
        Ref protectedThis { *this };
        if (!m_loader)
            return;

        m_response = WTF::move(response);
        storeBridgeCookies(m_firstParty, m_response.url(), setCookies);

        // Defensive: the shim only reports redirects via netDidReceiveRedirect,
        // but keep the policy check in case a 3xx-with-Location arrives here
        // (e.g. host chose not to treat it as a redirect).
        if (shouldRedirect()) {
            performRedirect();
            return;
        }

        m_loader->didReceiveResponse(ResourceResponse { m_response }, [this, protectedThis = Ref { *this }] {
            // Body bytes may already have streamed in while the (possibly
            // async, for main-resource policy) response handling ran; the
            // bridge queues them.
            m_responseCompleted = true;
            flushQueued();
        });
    }

    void netDidReceiveData(std::span<const uint8_t> bytes) final
    {
        Ref protectedThis { *this };
        if (!m_loader)
            return;
        auto buffer = SharedBuffer::create(bytes);
        if (!m_responseCompleted) {
            m_queuedBuffers.append(WTF::move(buffer));
            return;
        }
        long long size = buffer->size();
        m_loader->didReceiveBuffer(buffer.get(), size, DataPayloadBytes);
    }

    void netDidComplete() final
    {
        Ref protectedThis { *this };
        m_requestId = 0;
        if (!m_loader)
            return;
        if (!m_responseCompleted) {
            m_pendingComplete = true;
            return;
        }
        finishLoading();
    }

    void netDidFail(BIB::NetErrorKind kind, String&& message) final
    {
        Ref protectedThis { *this };
        m_requestId = 0;
        // Failures are easy to lose in a canvas-only embedder — always log.
        WTFLogAlways("BIB: load failed kind=%d %s (%s)", kind, m_response.url().string().utf8().data(), message.utf8().data());
        if (!m_loader)
            return;
        didFailInternal(ResourceError(embedderErrorDomain(), kind, m_loader->url(), message));
    }

    void netDidReceiveRedirect(ResourceResponse&& response, Vector<String>&& setCookies) final
    {
        Ref protectedThis { *this };
        m_requestId = 0;
        if (!m_loader)
            return;
        m_response = WTF::move(response);
        storeBridgeCookies(m_firstParty, m_response.url(), setCookies);
        if (!shouldRedirect()) {
            // 3xx without a usable Location: surface it as a plain response.
            m_loader->didReceiveResponse(ResourceResponse { m_response }, [this, protectedThis = Ref { *this }] {
                m_responseCompleted = true;
                flushQueued();
            });
            netDidComplete();
            return;
        }
        performRedirect();
    }

    void flushQueued()
    {
        Ref protectedThis { *this };
        auto queued = std::exchange(m_queuedBuffers, { });
        for (auto& buffer : queued) {
            if (!m_loader)
                return;
            long long size = buffer->size();
            m_loader->didReceiveBuffer(buffer.get(), size, DataPayloadBytes);
        }
        if (m_pendingComplete && m_loader)
            finishLoading();
    }

    void finishLoading()
    {
        RefPtr loader = m_loader;
        notifyDone();
        loader->didFinishLoading(NetworkLoadMetrics { });
    }

    RefPtr<ResourceLoader> m_loader;
    bool m_isTopLevelDocument { false };
    Function<void(BibResourceLoad&)> m_doneCallback;
    ResourceResponse m_response;
    URL m_firstParty;
    Vector<Ref<SharedBuffer>> m_queuedBuffers;
    int m_requestId { 0 };
    int m_redirectCount { 0 };
    bool m_responseCompleted { false };
    bool m_pendingComplete { false };
};

// --- Request blocklist ------------------------------------------------------
// CLoop parses every byte of script on the main thread, so analytics/ads/
// telemetry bundles (GTM, adsbygoogle, sentry, segment, ...) are pure boot
// cost. Refusing them in loadResource() means they never download OR parse.
// Main resources are exempt (navigations and iframe documents still load),
// and consent managers (OneTrust/cookielaw) are deliberately NOT listed —
// sites gate functionality on their callbacks. ?noblock=1 on the host page
// disables the list.
static bool g_requestBlocklistEnabled = true;

void setRequestBlocklistEnabled(bool enabled)
{
    g_requestBlocklistEnabled = enabled;
}

static bool isBlocklistedHost(StringView host)
{
    static constexpr ASCIILiteral blockedSuffixes[] = {
        // Google ads + analytics. GTM is a known tradeoff: rare sites wire
        // functional logic through it, but gtm.js + the tags it injects are
        // the single biggest parse cost on marketing pages — ?noblock=1 is
        // the escape hatch.
        "google-analytics.com"_s,
        "googletagmanager.com"_s,
        "googletagservices.com"_s,
        "googlesyndication.com"_s,
        "googleadservices.com"_s,
        "adservice.google.com"_s,
        "doubleclick.net"_s,
        // Error/telemetry reporters
        "sentry.io"_s,
        "sentry-cdn.com"_s,
        "bugsnag.com"_s,
        "nr-data.net"_s,
        "newrelic.com"_s,
        "datadoghq-browser-agent.com"_s,
        "browser-intake-datadoghq.com"_s,
        "cloudflareinsights.com"_s,
        // Product analytics
        "segment.com"_s,
        "segment.io"_s,
        "mixpanel.com"_s,
        "amplitude.com"_s,
        "hotjar.com"_s,
        "fullstory.com"_s,
        "clarity.ms"_s,
        "quantserve.com"_s,
        "scorecardresearch.com"_s,
        "chartbeat.com"_s,
        "mc.yandex.ru"_s,
        // Social pixels / ad networks. facebook.net is deliberately absent:
        // connect.facebook.net also serves the FB Login SDK (FB.login()),
        // so blocking it breaks "Login with Facebook" (Codex).
        "analytics.tiktok.com"_s,
        "static.ads-twitter.com"_s,
        "analytics.twitter.com"_s,
        "bat.bing.com"_s,
        "snap.licdn.com"_s,
        "px.ads.linkedin.com"_s,
        "amazon-adsystem.com"_s,
        "criteo.com"_s,
        "criteo.net"_s,
        "taboola.com"_s,
        "outbrain.com"_s,
    };
    // URL hosts are canonicalized to lowercase, so exact suffix matching is
    // enough; the dot check stops "notsentry.io" from matching "sentry.io".
    for (auto literal : blockedSuffixes) {
        StringView blocked { literal };
        if (host.length() < blocked.length() || !host.endsWith(blocked))
            continue;
        if (host.length() == blocked.length() || host[host.length() - blocked.length() - 1] == '.')
            return true;
    }
    return false;
}

class EmbedderLoaderStrategy final : public LoaderStrategy {
public:
    void scheduleLoad(ResourceLoader& loader, bool isTopLevelDocument = false)
    {
        // ResourceLoader::start() handles data: URLs internally, before the
        // ResourceHandle path (unreachable on a USE(CURL) port). blob:
        // URLs also work through start(): BlobRegistryImpl registers a
        // BlobResourceHandle constructor for the "blob" protocol in
        // ResourceHandle's builtin map, served from EmbedderBlobRegistry's
        // in-process impl — never the network.
        if (loader.request().url().protocolIsData() || loader.request().url().protocolIsBlob()) {
            loader.start();
            return;
        }

        auto load = BibResourceLoad::create(loader, isTopLevelDocument, [this](BibResourceLoad& load) {
            if (auto* loader = load.loader())
                m_loads.remove(loader);
        });
        m_loads.set(&loader, load.copyRef());
        load->start();
    }

private:
    void loadResource(LocalFrame& frame, CachedResource& resource, ResourceRequest&& request, const ResourceLoaderOptions& options, CompletionHandler<void(RefPtr<SubresourceLoader>&&)>&& completionHandler) final
    {
        // Null loader -> CachedResource::failBeforeStarting(): the documented
        // creation-failure path, so blocked scripts get ordinary error events.
        if (g_requestBlocklistEnabled && resource.type() != CachedResource::Type::MainResource && isBlocklistedHost(request.url().host())) {
            WTFLogAlways("BIB: blocked %s (request blocklist; ?noblock=1 to disable)", request.url().string().utf8().data());
            completionHandler(nullptr);
            return;
        }

        // 2.4: the flag must be derived HERE — DocumentLoader::m_mainResource
        // is not yet assigned while its load is being scheduled, so
        // mainResourceLoader()-based detection races to false.
        bool isTopLevelDocument = resource.type() == CachedResource::Type::MainResource && frame.isMainFrame();
        SubresourceLoader::create(frame, resource, WTF::move(request), options, [this, isTopLevelDocument, completionHandler = WTF::move(completionHandler)](RefPtr<SubresourceLoader>&& loader) mutable {
            if (loader)
                scheduleLoad(*loader, isTopLevelDocument);
            completionHandler(WTF::move(loader));
        });
    }

    void loadResourceSynchronously(FrameLoader&, ResourceLoaderIdentifier, const ResourceRequest& request, ClientCredentialPolicy, const FetchOptions&, const HTTPHeaderMap&, ResourceError& error, ResourceResponse&, Vector<uint8_t>&) final
    {
        // Single-threaded build cannot block on the network. Sync XHR fails.
        error = ResourceError(embedderErrorDomain(), 0, request.url(), "Synchronous loads are not supported in this embedder"_s);
    }

    void pageLoadCompleted(Page&) final { }
    void browsingContextRemoved(LocalFrame&) final { }

    void remove(ResourceLoader* loader) final
    {
        if (auto load = m_loads.take(loader))
            load->cancel();
    }

    void setDefersLoading(ResourceLoader&, bool) final
    {
        // The bridge has no pause-after-start; defers is best-effort here.
    }

    void crossOriginRedirectReceived(ResourceLoader*, const URL&) final { }

    void servePendingRequests(ResourceLoadPriority) final { }
    void suspendPendingRequests() final { }
    void resumePendingRequests() final { }

    void startPingLoad(LocalFrame&, ResourceRequest& request, const HTTPHeaderMap&, const FetchOptions&, ContentSecurityPolicyImposition, PingLoadCompletionHandler&& completionHandler) final
    {
        // sendBeacon / <a ping> / CSP reports. Fire-and-forget through a
        // self-owning bridge client — erroring these out made beacon-gated
        // code paths fail and spammed the console on every analytics-bearing
        // site. originalRequestHeaders/CORS are not applied (documented gap).
        if (g_requestBlocklistEnabled && isBlocklistedHost(request.url().host())) {
            // Complete as success: beacon callers cannot observe delivery,
            // and an error here would only trip SDK retry loops.
            WTFLogAlways("BIB: blocked beacon %s (request blocklist)", request.url().string().utf8().data());
            if (completionHandler)
                completionHandler({ }, { });
            return;
        }
        BibPingLoad::start(ResourceRequest { request }, WTF::move(completionHandler));
    }

    void preconnectTo(FrameLoader&, ResourceRequest&&, StoredCredentialsPolicy, ShouldPreconnectAsFirstParty, PreconnectCompletionHandler&& completionHandler) final
    {
        // Succeed as a no-op: the host's fetch() owns connection reuse, so
        // a warm-up dial buys nothing. Reporting an ERROR here (the old
        // behavior) just generated console noise for
        // every <link rel=preconnect>.
        if (completionHandler)
            completionHandler({ });
    }

    void setCaptureExtraNetworkLoadMetricsEnabled(bool) final { }

    bool isOnLine() const final { return true; }
    void addOnlineStateChangeListener(Function<void(bool)>&& listener) final
    {
        NetworkStateNotifier::singleton().addListener(WTF::move(listener));
    }

    void isResourceLoadFinished(CachedResource& resource, CompletionHandler<void(bool)>&& callback) final
    {
        if (!resource.loader()) {
            callback(true);
            return;
        }
        callback(!m_loads.contains(resource.loader()));
    }

    ResourceError cancelledError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "Load cancelled"_s, ResourceError::Type::Cancellation);
    }
    ResourceError blockedError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "Load blocked"_s, ResourceError::Type::AccessControl);
    }
    ResourceError blockedByContentBlockerError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "Blocked by content blocker"_s, ResourceError::Type::AccessControl);
    }
    ResourceError cannotShowURLError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "Cannot show URL"_s, ResourceError::Type::AccessControl);
    }
    ResourceError interruptedForPolicyChangeError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "Interrupted for policy change"_s);
    }
    ResourceError cannotShowMIMETypeError(const ResourceResponse& response) const final
    {
        return ResourceError(embedderErrorDomain(), 0, response.url(), "Cannot show MIME type"_s);
    }
    ResourceError fileDoesNotExistError(const ResourceResponse& response) const final
    {
        return ResourceError(embedderErrorDomain(), 0, response.url(), "File does not exist"_s);
    }
    ResourceError httpsUpgradeRedirectLoopError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "HTTPS upgrade redirect loop"_s);
    }
    ResourceError httpNavigationWithHTTPSOnlyError(const ResourceRequest& request) const final
    {
        return ResourceError(embedderErrorDomain(), 0, request.url(), "HTTP navigation with HTTPS-only"_s);
    }
    ResourceError pluginWillHandleLoadError(const ResourceResponse& response) const final
    {
        return ResourceError(embedderErrorDomain(), 0, response.url(), "Plugin will handle load"_s);
    }

    HashMap<ResourceLoader*, Ref<BibResourceLoad>> m_loads;
};

class EmbedderMediaStrategy final : public MediaStrategy {
    // VIDEO / WEB_AUDIO / MEDIA_SOURCE are OFF: no pure virtuals remain.
};

// In-process BlobRegistry forwarding to WebCore's own BlobRegistryImpl —
// the single-process equivalent of WebKitLegacy's WebBlobRegistry. The
// blobRegistryImpl() override is what lets loaders resolve blob: data
// without IPC.
class EmbedderBlobRegistry final : public WebCore::BlobRegistry {
    void registerInternalFileBlobURL(const URL& url, Ref<BlobDataFileReference>&& file, const String&, const String& contentType) final
    {
        m_impl.registerInternalFileBlobURL(url, WTF::move(file), contentType);
    }

    void registerInternalBlobURL(const URL& url, Vector<BlobPart>&& parts, const String& contentType) final
    {
        m_impl.registerInternalBlobURL(url, WTF::move(parts), contentType);
    }

    void registerBlobURL(const URL& url, const URL& srcURL, const PolicyContainer& policyContainer, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.registerBlobURL(url, srcURL, policyContainer, topOrigin);
    }

    void registerInternalBlobURLOptionallyFileBacked(const URL& url, const URL& srcURL, RefPtr<BlobDataFileReference>&& file, const String& contentType) final
    {
        m_impl.registerInternalBlobURLOptionallyFileBacked(url, srcURL, WTF::move(file), contentType, { });
    }

    void registerInternalBlobURLForSlice(const URL& url, const URL& srcURL, long long start, long long end, const String& contentType) final
    {
        m_impl.registerInternalBlobURLForSlice(url, srcURL, start, end, contentType);
    }

    void unregisterBlobURL(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.unregisterBlobURL(url, topOrigin);
    }

    void registerBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.registerBlobURLHandle(url, topOrigin);
    }

    void unregisterBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.unregisterBlobURLHandle(url, topOrigin);
    }

    String blobType(const URL& url) final { return m_impl.blobType(url); }
    unsigned long long blobSize(const URL& url) final { return m_impl.blobSize(url); }

    void writeBlobsToTemporaryFilesForIndexedDB(const Vector<String>& blobURLs, CompletionHandler<void(Vector<String>&& filePaths)>&& completionHandler) final
    {
        m_impl.writeBlobsToTemporaryFilesForIndexedDB(blobURLs, WTF::move(completionHandler));
    }

    BlobRegistryImpl* blobRegistryImpl() final { return &m_impl; }

    BlobRegistryImpl m_impl;
};

class EmbedderPlatformStrategies final : public PlatformStrategies {
    LoaderStrategy* createLoaderStrategy() final
    {
        static NeverDestroyed<EmbedderLoaderStrategy> strategy;
        return &strategy.get();
    }

    PasteboardStrategy* createPasteboardStrategy() final
    {
        // PasteboardEmscripten.cpp never consults the strategy.
        return nullptr;
    }

    MediaStrategy* createMediaStrategy() final
    {
        static NeverDestroyed<EmbedderMediaStrategy> strategy;
        return &strategy.get();
    }

    BlobRegistry* createBlobRegistry() final
    {
        // In-process registry backed by WebCore's BlobRegistryImpl (the
        // WebKitLegacy WebBlobRegistry pattern). Returning nullptr here
        // aborted the engine on the FIRST `new Blob(...)` any page ran —
        // blobRegistry() CheckedRefs the pointer (root cause #9;
        // google/ebay/Turnstile all died on it).
        static NeverDestroyed<EmbedderBlobRegistry> registry;
        return &registry.get();
    }
};

void installEmbedderStrategies()
{
    static NeverDestroyed<EmbedderPlatformStrategies> strategies;
    setPlatformStrategies(&strategies.get());
}

} // namespace BIB
