// Guest WebSocket channel, phase WS-1: a real RFC 6455 client over the
// curl stack (task #58). Replaces BibFailFastWebSocketChannel.
//
// Model: WebKit2's WebSocketTaskCurl (Source/WebKit/NetworkProcess/curl/
// WebSocketTaskCurl.cpp) — a CurlStream (curl easy handle in CONNECT_ONLY
// mode, TCP+TLS only) plus WebCore's own WebSocket protocol classes
// (WebSocketHandshake / WebSocketFrame / WebSocketDeflateFramer), all of
// which still compile in WebCore even though the in-WebCore channel is
// gone. Differences from the WebKit2 task:
//   - We implement ThreadableWebSocketChannel directly and drive the
//     WebSocketChannelClient (the WebSocket DOM object) without the
//     NetworkSocketChannel IPC hop. Client callbacks self-queue inside
//     WebSocket via queueTaskKeepingObjectAlive, so direct synchronous
//     calls are safe (same property WS-0 relied on).
//   - Cookies come from the embedder's single NetworkStorageSession.
//   - CurlStreamScheduler runs as a main-thread pump on this port (the
//     CurlRequestScheduler single-threading recipe; already patched).
//   - Server-trust failure is terminal: no challenge UI exists, so
//     CURLE_PEER_FAILED_VERIFICATION fails the socket like any error.
//
// Documented gaps: send(Blob) drops the message with a console warning
// (needs an async blob read; nothing pre-gateway uses it), and
// bufferedAmount is never reported (didUpdateBufferedAmount unused —
// advisory only).

#pragma once

#include "CookieJar.h"
#include "CurlContext.h"
#include "CurlStream.h"
#include "CurlStreamScheduler.h"
#include "Document.h"
#include "HTTPHeaderNames.h"
#include "NetworkStorageSession.h"
#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include "SameSiteInfo.h"
#include "ShouldRelaxThirdPartyCookieBlocking.h"
#include "ThreadableWebSocketChannel.h"
#include "WebSocketChannelClient.h"
#include "WebSocketDeflateFramer.h"
#include "WebSocketFrame.h"
#include "WebSocketHandshake.h"
#include <JavaScriptCore/ArrayBuffer.h>
#include <JavaScriptCore/ConsoleTypes.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/StdLibExtras.h>
#include <wtf/UniqueArray.h>
#include <wtf/Vector.h>
#include <wtf/WeakPtr.h>
#include <wtf/text/CString.h>
#include <wtf/text/MakeString.h>

namespace BIB {

WebCore::NetworkStorageSession& embedderStorageSession(); // EmbedderStrategies.cpp

class BibWebSocketChannel final : public RefCounted<BibWebSocketChannel>, public WebCore::ThreadableWebSocketChannel, public WebCore::CurlStream::Client {
public:
    static Ref<BibWebSocketChannel> create(WebCore::Document& document, WebCore::WebSocketChannelClient& client)
    {
        return adoptRef(*new BibWebSocketChannel(document, client));
    }

    ~BibWebSocketChannel()
    {
        destructStream();
    }

    // AbstractRefCounted (via ThreadableWebSocketChannel) — same idiom as
    // WorkerThreadableWebSocketChannel.
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    // --- ThreadableWebSocketChannel ------------------------------------

    ConnectStatus connect(const URL& url, const String& protocol) final
    {
        RefPtr document = m_document.get();
        if (!document)
            return ConnectStatus::KO;

        auto request = webSocketConnectRequest(*document, url);
        if (!request)
            return ConnectStatus::KO;

        m_request = WTF::move(*request);
        m_protocol = protocol;

        // validateURL (inside webSocketConnectRequest) can promote ws: to
        // wss: for HTTPS-upgrade; the DOM WebSocket only learns about the
        // rewrite through didUpgradeURL (Codex).
        if (m_request.url() != url) {
            if (RefPtr client = m_client.get())
                client->didUpgradeURL();
        }

        // didOpen/didReceiveData/didFail arrive later through the
        // scheduler's main-thread pump — nothing reaches the client from
        // inside the WebSocket constructor.
        m_streamID = m_scheduler.createStream(m_request.url(), *this, WebCore::CurlStream::ServerTrustEvaluation::Enable, WebCore::CurlStream::LocalhostAlias::Disable);
        return ConnectStatus::OK;
    }

    String subprotocol() final { return m_subprotocol.isNull() ? emptyString() : m_subprotocol; }
    String extensions() final { return m_extensions.isNull() ? emptyString() : m_extensions; }

    void send(CString&& message) final
    {
        if (m_state != State::Opened)
            return;
        if (!sendFrame(WebCore::WebSocketFrame::OpCodeText, byteCast<uint8_t>(message.span())))
            didFailInternal("Failed to send WebSocket frame."_s);
    }

    void send(const JSC::ArrayBuffer& binaryData, unsigned byteOffset, unsigned byteLength) final
    {
        if (m_state != State::Opened)
            return;
        auto data = unsafeMakeSpan(static_cast<const uint8_t*>(binaryData.data()) + byteOffset, byteLength);
        if (!sendFrame(WebCore::WebSocketFrame::OpCodeBinary, data))
            didFailInternal("Failed to send WebSocket frame."_s);
    }

    void send(WebCore::Blob&) final
    {
        // Needs an async blob read before framing; nothing exercised
        // pre-gateway sends blobs. Warn instead of silently succeeding.
        if (RefPtr document = m_document.get())
            document->addConsoleMessage(JSC::MessageSource::Network, JSC::MessageLevel::Warning, "BrowserInBrowser: WebSocket Blob sends are not implemented; message dropped"_s);
    }

    void close(int code, const String& reason) final
    {
        Ref protectedThis { *this };

        if (m_state == State::Closed)
            return;

        if (m_state == State::Connecting || m_state == State::Handshaking) {
            didCloseInternal(CloseEventCodeAbnormalClosure, { });
            return;
        }

        sendClosingHandshakeIfNeeded(code, reason);
    }

    void fail(String&& reason) final
    {
        Ref protectedThis { *this };
        didFailInternal(WTF::move(reason));
    }

    void disconnect() final
    {
        // Called when the WebSocket goes away (GC/stop): suppress didClose.
        m_client = nullptr;
        m_state = State::Closed;
        destructStream();
    }

    // WebSocket's events self-queue against the Document's task queues,
    // which are already paused while the document is suspended — nothing
    // extra to do on this single-page embedder.
    void suspend() final { }
    void resume() final { }

    WebCore::WebSocketChannelIdentifier progressIdentifier() const final { return m_progressIdentifier; }
    bool hasCreatedHandshake() const final { return m_state != State::Connecting; }
    bool isConnected() const final { return m_state == State::Opened; }

    WebCore::ResourceRequest clientHandshakeRequest(const CookieGetter& cookieGetter) const final
    {
        // The real RFC 6455 request (Sec-WebSocket-Key etc.) is captured at
        // didOpen for the Inspector; before that, fall back to the plain
        // connect request (Codex).
        if (m_clientHandshakeRequest.isNull())
            return m_request;
        auto request = m_clientHandshakeRequest;
        if (m_request.allowCookies()) {
            auto cookieHeader = cookieGetter(m_request.url());
            if (!cookieHeader.isEmpty())
                request.addHTTPHeaderField(WebCore::HTTPHeaderName::Cookie, cookieHeader);
        }
        return request;
    }

    const WebCore::ResourceResponse& serverHandshakeResponse() const final { return m_serverHandshakeResponse; }

private:
    BibWebSocketChannel(WebCore::Document& document, WebCore::WebSocketChannelClient& client)
        : m_document(document)
        , m_client(client)
        , m_progressIdentifier(WebCore::WebSocketChannelIdentifier::generate())
        , m_scheduler(WebCore::CurlContext::singleton().streamScheduler())
    {
    }

    enum class State : uint8_t {
        Connecting,
        Handshaking,
        Opened,
        Closing,
        Closed
    };

    // --- CurlStream::Client (delivered via the scheduler's main-thread
    // pump, never re-entrantly from our own calls) ----------------------

    void didOpen(WebCore::CurlStreamID) final
    {
        Ref protectedThis { *this };

        if (m_state != State::Connecting)
            return;

        m_state = State::Handshaking;

        m_handshake = makeUnique<WebCore::WebSocketHandshake>(m_request.url(), m_protocol, m_request.httpUserAgent(), m_request.httpHeaderField(WebCore::HTTPHeaderName::Origin), m_request.allowCookies(), false);
        m_handshake->reset();
        m_handshake->addExtensionProcessor(m_deflateFramer.createExtensionProcessor());

        CString cookieHeader;
        if (m_request.allowCookies()) {
            auto includeSecureCookies = m_request.url().protocolIs("wss"_s) ? WebCore::IncludeSecureCookies::Yes : WebCore::IncludeSecureCookies::No;
            auto cookieHeaderField = embedderStorageSession().cookieRequestHeaderFieldValue(m_request.firstPartyForCookies(), WebCore::SameSiteInfo::create(m_request), m_request.url(), std::nullopt, std::nullopt, includeSecureCookies, WebCore::ApplyTrackingPrevention::Yes, WebCore::ShouldRelaxThirdPartyCookieBlocking::No, WebCore::IsKnownCrossSiteTracker::No).first;
            if (!cookieHeaderField.isEmpty())
                cookieHeader = makeString("Cookie: "_s, cookieHeaderField, "\r\n"_s).utf8();
        }

        // Keep the synthesized RFC 6455 request around for the Inspector —
        // m_handshake is gone once the server response validates. Cookies
        // are deliberately not baked in (the accessor's CookieGetter adds
        // them on demand).
        m_clientHandshakeRequest = m_handshake->clientHandshakeRequest([](const URL&) {
            return String();
        });

        // Splice the Cookie header in before the handshake's final CRLF
        // (the WebSocketTaskCurl recipe).
        auto originalMessage = m_handshake->clientHandshakeMessage();
        auto handshakeMessageLength = originalMessage.length() + cookieHeader.length();
        auto handshakeMessage = makeUniqueArray<uint8_t>(handshakeMessageLength);

        memcpy(handshakeMessage.get(), originalMessage.data(), originalMessage.length());
        if (!cookieHeader.isNull() && cookieHeader.length()) {
            memcpy(handshakeMessage.get() + originalMessage.length() - 2, cookieHeader.data(), cookieHeader.length());
            memcpy(handshakeMessage.get() + handshakeMessageLength - 2, "\r\n", 2);
        }

        m_scheduler.send(m_streamID, WTF::move(handshakeMessage), handshakeMessageLength);
    }

    void didSendData(WebCore::CurlStreamID, size_t) final { }

    void didReceiveData(WebCore::CurlStreamID, const WebCore::SharedBuffer& buffer) final
    {
        Ref protectedThis { *this };

        if (m_state == State::Connecting || m_state == State::Closed)
            return;

        if (!buffer.size()) {
            // Orderly TCP shutdown from the server.
            didCloseInternal(CloseEventCodeAbnormalClosure, { });
            return;
        }

        if (m_shouldDiscardReceivedData || m_receivedClosingHandshake)
            return;

        if (!appendReceivedBuffer(buffer)) {
            didFailInternal("Ran out of memory while receiving WebSocket data."_s);
            return;
        }

        auto validateResult = validateOpeningHandshake();
        if (!validateResult.has_value()) {
            didFailInternal(String(validateResult.error()));
            return;
        }
        if (!validateResult.value())
            return;

        auto frameResult = receiveFrames([this](WebCore::WebSocketFrame::OpCode opCode, std::span<const uint8_t> data) {
            switch (opCode) {
            case WebCore::WebSocketFrame::OpCodeText: {
                String message = data.size() ? String::fromUTF8(data) : emptyString();
                if (message.isNull()) {
                    didFailInternal("Could not decode a text frame as UTF-8."_s);
                    break;
                }
                if (RefPtr client = m_client.get())
                    client->didReceiveMessage(WTF::move(message));
                break;
            }

            case WebCore::WebSocketFrame::OpCodeBinary:
                if (RefPtr client = m_client.get())
                    client->didReceiveBinaryData(Vector<uint8_t> { data });
                break;

            case WebCore::WebSocketFrame::OpCodeClose:
                if (!data.size())
                    m_closeEventCode = CloseEventCodeNoStatusRcvd;
                else if (data.size() == 1) {
                    m_closeEventCode = CloseEventCodeAbnormalClosure;
                    didFailInternal("Received a broken close frame containing an invalid size body."_s);
                    return;
                } else {
                    auto highByte = static_cast<unsigned char>(data[0]);
                    auto lowByte = static_cast<unsigned char>(data[1]);
                    m_closeEventCode = highByte << 8 | lowByte;
                    if (m_closeEventCode == CloseEventCodeNoStatusRcvd || m_closeEventCode == CloseEventCodeAbnormalClosure || m_closeEventCode == CloseEventCodeTLSHandshake) {
                        m_closeEventCode = CloseEventCodeAbnormalClosure;
                        didFailInternal("Received a broken close frame containing a reserved status code."_s);
                        return;
                    }
                }
                if (data.size() >= 3)
                    m_closeEventReason = String::fromUTF8(data.subspan(2));
                else
                    m_closeEventReason = emptyString();

                m_receivedClosingHandshake = true;
                if (RefPtr client = m_client.get())
                    client->didStartClosingHandshake();
                sendClosingHandshakeIfNeeded(m_closeEventCode, m_closeEventReason);
                didCloseInternal(m_closeEventCode, m_closeEventReason);
                break;

            case WebCore::WebSocketFrame::OpCodePing:
                if (!sendFrame(WebCore::WebSocketFrame::OpCodePong, data))
                    didFailInternal("Failed to send WebSocket frame."_s);
                break;

            case WebCore::WebSocketFrame::OpCodeContinuation:
            case WebCore::WebSocketFrame::OpCodePong:
            case WebCore::WebSocketFrame::OpCodeInvalid:
                break;
            }
        });

        if (frameResult) {
            didFailInternal(String(*frameResult));
            return;
        }
    }

    void didFail(WebCore::CurlStreamID, CURLcode errorCode, WebCore::CertificateInfo&&) final
    {
        Ref protectedThis { *this };
        // No challenge UI: cert verification failure is terminal like any
        // other socket error.
        didFailInternal(makeString("WebSocket network error: error code "_s, static_cast<uint32_t>(errorCode)));
    }

    // --- protocol machinery (ported from WebSocketTaskCurl) ------------

    bool appendReceivedBuffer(const WebCore::SharedBuffer& buffer)
    {
        size_t newBufferSize = m_receiveBuffer.size() + buffer.size();
        if (newBufferSize < m_receiveBuffer.size())
            return false;

        m_receiveBuffer.append(buffer.span());
        return true;
    }

    void skipReceivedBuffer(size_t length)
    {
        memmoveSpan(m_receiveBuffer.mutableSpan(), m_receiveBuffer.subspan(length));
        m_receiveBuffer.shrink(m_receiveBuffer.size() - length);
    }

    Expected<bool, String> validateOpeningHandshake()
    {
        if (m_didCompleteOpeningHandshake)
            return true;

        if (m_state != State::Handshaking || !m_handshake || m_handshake->mode() != WebCore::WebSocketHandshake::Incomplete) {
            m_handshake = nullptr;
            return makeUnexpected("Unexpected handshaking condition"_s);
        }

        auto headerLength = m_handshake->readServerHandshake(m_receiveBuffer.span());
        if (headerLength <= 0)
            return false;

        skipReceivedBuffer(headerLength);

        if (m_handshake->mode() != WebCore::WebSocketHandshake::Connected) {
            auto reason = m_handshake->failureReason();
            m_handshake = nullptr;
            return makeUnexpected(reason);
        }

        auto serverSetCookie = m_handshake->serverSetCookie();
        if (!serverSetCookie.isEmpty())
            embedderStorageSession().setCookiesFromHTTPResponse(m_request.firstPartyForCookies(), m_request.url(), serverSetCookie);

        m_state = State::Opened;
        m_didCompleteOpeningHandshake = true;

        // WebSocket::didConnect() reads these back through subprotocol()
        // and extensions(), so they must be set before the callback.
        m_subprotocol = m_handshake->serverWebSocketProtocol();
        m_extensions = m_handshake->acceptedExtensions();
        m_serverHandshakeResponse = m_handshake->serverHandshakeResponse();
        m_handshake = nullptr;

        if (RefPtr client = m_client.get())
            client->didConnect();
        return true;
    }

    std::optional<String> receiveFrames(Function<void(WebCore::WebSocketFrame::OpCode, std::span<const uint8_t>)>&& callback)
    {
        if (m_state != State::Opened && m_state != State::Closing)
            return std::nullopt;

        while (m_receiveBuffer.size() && !m_shouldDiscardReceivedData && !m_receivedClosingHandshake) {
            WebCore::WebSocketFrame frame;
            const uint8_t* frameEnd;
            String errorString;
            auto parseResult = WebCore::WebSocketFrame::parseFrame(m_receiveBuffer.mutableSpan(), frame, frameEnd, errorString);
            if (parseResult == WebCore::WebSocketFrame::FrameIncomplete)
                return std::nullopt;
            if (parseResult == WebCore::WebSocketFrame::FrameError)
                return errorString;

            auto inflateResult = m_deflateFramer.inflate(frame);
            if (!inflateResult->succeeded())
                return inflateResult->failureReason();

            if (auto validateResult = validateFrame(frame))
                return *validateResult;

            if (!frame.final || frame.opCode == WebCore::WebSocketFrame::OpCodeContinuation) {
                if (frame.opCode != WebCore::WebSocketFrame::OpCodeContinuation) {
                    m_hasContinuousFrame = true;
                    m_continuousFrameOpCode = frame.opCode;
                }

                m_continuousFrameData.append(frame.payload);

                if (frame.final) {
                    callback(m_continuousFrameOpCode, m_continuousFrameData.span());
                    m_hasContinuousFrame = false;
                    m_continuousFrameData.clear();
                }
            } else
                callback(frame.opCode, frame.payload);

            // The callback can fail/close the channel, which empties the
            // buffer (didFailInternal) — re-check before skipping.
            if (!m_receiveBuffer.isEmpty())
                skipReceivedBuffer(frameEnd - m_receiveBuffer.begin());
        }

        return std::nullopt;
    }

    std::optional<String> validateFrame(const WebCore::WebSocketFrame& frame)
    {
        if (WebCore::WebSocketFrame::isReservedOpCode(frame.opCode))
            return makeString("Unrecognized frame opcode: "_s, static_cast<unsigned>(frame.opCode));

        if (frame.reserved2 || frame.reserved3)
            return makeString("One or more reserved bits are on: reserved2 = "_s, static_cast<unsigned>(frame.reserved2), ", reserved3 = "_s, static_cast<unsigned>(frame.reserved3));

        if (frame.masked)
            return "A server must not mask any frames that it sends to the client."_s;

        // Control frames must not be fragmented...
        if (WebCore::WebSocketFrame::isControlOpCode(frame.opCode) && !frame.final)
            return makeString("Received fragmented control frame: opcode = "_s, static_cast<unsigned>(frame.opCode));

        // ...and must fit in 125 bytes.
        if (WebCore::WebSocketFrame::isControlOpCode(frame.opCode) && WebCore::WebSocketFrame::needsExtendedLengthField(frame.payload.size()))
            return makeString("Received control frame having too long payload: "_s, frame.payload.size(), " bytes"_s);

        // A new data frame must not start while a continuation is open
        // (control frames may interleave).
        if (m_hasContinuousFrame && frame.opCode != WebCore::WebSocketFrame::OpCodeContinuation && !WebCore::WebSocketFrame::isControlOpCode(frame.opCode))
            return "Received new data frame but previous continuous frame is unfinished."_s;

        if (!m_hasContinuousFrame && frame.opCode == WebCore::WebSocketFrame::OpCodeContinuation)
            return "Received unexpected continuation frame."_s;

        return std::nullopt;
    }

    void sendClosingHandshakeIfNeeded(int32_t code, const String& reason)
    {
        if (m_didSendClosingHandshake)
            return;

        Vector<uint8_t> buf;
        if (!m_receivedClosingHandshake && code != CloseEventCodeNotSpecified) {
            unsigned char highByte = static_cast<unsigned short>(code) >> 8;
            unsigned char lowByte = static_cast<unsigned short>(code);
            buf.append(static_cast<char>(highByte));
            buf.append(static_cast<char>(lowByte));
            buf.append(reason.utf8().span());
        }

        if (!sendFrame(WebCore::WebSocketFrame::OpCodeClose, buf.span()))
            didFailInternal("Failed to send WebSocket frame."_s);

        m_state = State::Closing;
        m_didSendClosingHandshake = true;
    }

    bool sendFrame(WebCore::WebSocketFrame::OpCode opCode, std::span<const uint8_t> data)
    {
        if (m_didSendClosingHandshake)
            return true;

        WebCore::WebSocketFrame frame(opCode, true, false, true, data);

        auto deflateResult = m_deflateFramer.deflate(frame);
        if (!deflateResult->succeeded()) {
            didFailInternal(deflateResult->failureReason());
            return false;
        }

        Vector<uint8_t> frameData;
        frame.makeFrameData(frameData);

        auto buffer = makeUniqueArray<uint8_t>(frameData.size());
        memcpySpan(unsafeMakeSpan(buffer.get(), frameData.size()), frameData.span());

        m_scheduler.send(m_streamID, WTF::move(buffer), frameData.size());
        return true;
    }

    void didFailInternal(String&& reason)
    {
        if (m_receivedDidFail)
            return;

        m_receivedDidFail = true;

        if (RefPtr document = m_document.get())
            document->addConsoleMessage(JSC::MessageSource::Network, JSC::MessageLevel::Error, makeString("WebSocket connection to "_s, m_request.url().string(), " failed: "_s, reason));

        // RFC 6455 7.1.7: stop handling incoming data once failed.
        m_shouldDiscardReceivedData = true;
        if (!m_receiveBuffer.isEmpty())
            skipReceivedBuffer(m_receiveBuffer.size());
        m_deflateFramer.didFail();
        m_hasContinuousFrame = false;
        m_continuousFrameData.clear();

        if (RefPtr client = m_client.get())
            client->didReceiveMessageError(WTF::move(reason));
        didCloseInternal(CloseEventCodeAbnormalClosure, { });
    }

    void didCloseInternal(int32_t code, const String& reason)
    {
        destructStream();

        if (m_state == State::Closed)
            return;

        m_state = State::Closed;

        if (RefPtr client = m_client.get())
            client->didClose(0, m_receivedClosingHandshake ? WebCore::WebSocketChannelClient::ClosingHandshakeComplete : WebCore::WebSocketChannelClient::ClosingHandshakeIncomplete, code, reason);
    }

    void destructStream()
    {
        if (m_streamID == WebCore::invalidCurlStreamID)
            return;

        m_scheduler.destroyStream(m_streamID);
        m_streamID = WebCore::invalidCurlStreamID;
    }

    WeakPtr<WebCore::Document, WebCore::WeakPtrImplWithEventTargetData> m_document;
    ThreadSafeWeakPtr<WebCore::WebSocketChannelClient> m_client;
    WebCore::WebSocketChannelIdentifier m_progressIdentifier;

    WebCore::CurlStreamScheduler& m_scheduler;
    WebCore::CurlStreamID m_streamID { WebCore::invalidCurlStreamID };

    WebCore::ResourceRequest m_request;
    WebCore::ResourceRequest m_clientHandshakeRequest;
    String m_protocol;
    String m_subprotocol;
    String m_extensions;
    WebCore::ResourceResponse m_serverHandshakeResponse;

    State m_state { State::Connecting };

    std::unique_ptr<WebCore::WebSocketHandshake> m_handshake;
    WebCore::WebSocketDeflateFramer m_deflateFramer;

    bool m_didCompleteOpeningHandshake { false };

    bool m_shouldDiscardReceivedData { false };
    Vector<uint8_t> m_receiveBuffer;

    bool m_hasContinuousFrame { false };
    WebCore::WebSocketFrame::OpCode m_continuousFrameOpCode { WebCore::WebSocketFrame::OpCodeInvalid };
    Vector<uint8_t> m_continuousFrameData;

    bool m_receivedClosingHandshake { false };
    int32_t m_closeEventCode { CloseEventCodeNotSpecified };
    String m_closeEventReason;

    bool m_didSendClosingHandshake { false };
    bool m_receivedDidFail { false };
};

} // namespace BIB
