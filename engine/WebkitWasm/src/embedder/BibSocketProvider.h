// Guest WebSocket provider (task #58).
//
// pageConfigurationWithEmptyClients installs EmptySocketProvider, whose
// createWebSocketChannel returns nullptr — and WebSocket::create RELEASE_
// ASSERTs on that ("Every ScriptExecutionContext should have a
// SocketProvider"), so ANY guest `new WebSocket()` aborted the whole engine
// before WS-0 (discord.com/login died on its remote-auth gateway socket).
// WebKit ≥2.46 has no in-WebCore channel implementation left to borrow (it
// moved to the WebKit2 network process); SocketProvider::
// createWebSocketChannel is pure virtual, so the channel is ours — same
// situation as IndexedDB (BibIDBServer).
//
// WS-0 (d95feaf) failed every connection like an unreachable server; WS-1
// replaces that with BibWebSocketChannel, a real RFC 6455 client over
// CurlStream (see BibWebSocketChannel.h).

#pragma once

#include "BibWebSocketChannel.h"
#include "SocketProvider.h"
#include "WebTransportSession.h"

namespace BIB {

class BibSocketProvider final : public WebCore::SocketProvider {
public:
    static Ref<BibSocketProvider> create() { return adoptRef(*new BibSocketProvider); }

    RefPtr<WebCore::ThreadableWebSocketChannel> createWebSocketChannel(WebCore::Document& document, WebCore::WebSocketChannelClient& client) final
    {
        return BibWebSocketChannel::create(document, client);
    }

    // Same answer as EmptySocketProvider: WebTransport is unsupported.
    std::pair<RefPtr<WebCore::WebTransportSession>, Ref<WebCore::WebTransportSessionPromise>> initializeWebTransportSession(WebCore::ScriptExecutionContext&, WebCore::WebTransportSessionClient&, const URL&, const WebCore::WebTransportOptions&) final
    {
        return { nullptr, WebCore::WebTransportSessionPromise::createAndReject() };
    }

private:
    BibSocketProvider() = default;
};

} // namespace BIB
