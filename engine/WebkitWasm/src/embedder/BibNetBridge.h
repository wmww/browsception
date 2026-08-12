// Host-fetch network bridge (browsception ABI: bib_abi.h).
//
// Replaces the curl transport: the engine emits abstract requests to the
// host page (Module.bibNetBegin) and receives response/data/done/fail/
// redirect back through the bib_net_* exports (defined in BibNetBridge.cpp,
// self-proxying to the engine thread like every other export).
//
// Everything here runs on the engine thread. One request id maps to exactly
// one terminal callback: netDidComplete, netDidFail, or netDidReceiveRedirect.

#pragma once

#include "ResourceRequest.h"
#include "ResourceResponse.h"
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

namespace BIB {

// bib_net_fail kinds (mirror of BIB_NET_ERR_* in bib_abi.h).
enum NetErrorKind {
    NetErrGuard = 1,
    NetErrNetwork = 2,
    NetErrTimeout = 3,
    NetErrTooLarge = 4,
    NetErrCancelled = 5,
    NetErrProtocol = 6,
};

class NetBridgeClient {
public:
    virtual ~NetBridgeClient() = default;

    // setCookies carries each Set-Cookie value separately (the response's
    // combined header map is lossy for cookie storage).
    virtual void netDidReceiveResponse(WebCore::ResourceResponse&&, Vector<String>&& setCookies) = 0;
    virtual void netDidReceiveData(std::span<const uint8_t>) = 0;
    virtual void netDidComplete() = 0;
    virtual void netDidFail(NetErrorKind, String&& message) = 0;
    // A 3xx the host refused to follow; the client applies redirect policy
    // and issues the next hop as a fresh request.
    virtual void netDidReceiveRedirect(WebCore::ResourceResponse&&, Vector<String>&& setCookies) = 0;
};

// Serialize + emit the request; returns the request id. The client pointer
// must stay valid until a terminal callback or netBridgeCancel.
/* isTopLevelDocument marks a main-frame document request ("main":1 in the
 * request JSON) — the host bridge applies its sandboxed->native boundary
 * policy to exactly those. */
int netBridgeStart(NetBridgeClient&, const WebCore::ResourceRequest&, bool isTopLevelDocument = false);

// Abort an in-flight request (emits bibNetCancel, unregisters; no terminal
// callback will follow).
void netBridgeCancel(int id);

} // namespace BIB
