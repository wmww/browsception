// In-memory web storage (localStorage / sessionStorage).
//
// Two stacked empty-clients traps (root cause #11, same family as cookies):
//   1. The WebCore-layer defaults for LocalStorageEnabled and
//      SessionStorageEnabled are FALSE (only the WebKit/WebKitLegacy wrapper
//      layers flip them on) — the window properties are IDL-gated, so for a
//      raw-Page embedder `window.localStorage` is a ReferenceError, which
//      modern site bootstraps treat as fatal. main.cpp flips both settings.
//   2. Even with the settings on, EmptyStorageNamespaceProvider hands out
//      write-discarding StorageAreas. This provider backs every area with a
//      real WebCore::StorageMap (quota-enforcing, the same store
//      WebKitLegacy's StorageAreaImpl uses).
//
// Contents are in-memory; LOCAL areas additionally round-trip through the
// host page's OPFS persistence blob (main.cpp bibMaybePersist / seed):
// imported origins wait in bibPendingStorageImport() until the guest first
// opens that origin's storage, materialized areas register themselves in
// bibLocalAreaRegistry() so the dump can walk them. Session/TransientLocal
// areas stay tab-lifetime by design (matches real-browser semantics).

#pragma once

#include "SecurityOrigin.h"
#include "SecurityOriginData.h"
#include "StorageArea.h"
#include "StorageMap.h"
#include "StorageNamespace.h"
#include "StorageNamespaceProvider.h"
#include "StorageType.h"
#include <pal/SessionID.h>
#include <wtf/HashMap.h>
#include <wtf/text/StringHash.h>

namespace BIB {

class BibStorageArea;

// Persistence registries (defined in main.cpp; engine-thread only).
// Keyed by SecurityOriginData::toString() (e.g. "https://discord.com").
HashMap<String, RefPtr<BibStorageArea>>& bibLocalAreaRegistry();
HashMap<String, HashMap<String, String>>& bibPendingStorageImport();

class BibStorageArea final : public WebCore::StorageArea {
public:
    BibStorageArea(WebCore::StorageType type, unsigned quota)
        : m_type(type)
        , m_map(quota)
    {
    }

    // Persistence import: bypasses the LocalFrame-taking setItem (no frame
    // exists at seed time). Quota still enforced; an over-quota seed (only
    // possible if the OPFS file was edited by hand — our own dumps come
    // from quota-respecting maps) silently truncates the origin's import,
    // and the truncated set is what persists next. Accepted (Codex LOW).
    void importItem(const String& key, const String& value)
    {
        String oldValue;
        bool quotaException = false;
        m_map.setItem(key, value, oldValue, quotaException);
    }

    template<typename Functor> void forEachItem(Functor&& functor)
    {
        for (unsigned i = 0; i < m_map.length(); ++i) {
            String key = m_map.key(i);
            functor(key, m_map.getItem(key));
        }
    }

private:
    unsigned length() final { return m_map.length(); }
    String key(unsigned index) final { return m_map.key(index); }
    String item(const String& key) final { return m_map.getItem(key); }
    bool contains(const String& key) final { return m_map.contains(key); }
    WebCore::StorageType storageType() const final { return m_type; }
    size_t memoryBytesUsedByCache() final { return 0; }

    void setItem(WebCore::LocalFrame&, const String& key, const String& value, bool& quotaException) final
    {
        String oldValue;
        m_map.setItem(key, value, oldValue, quotaException);
    }

    void removeItem(WebCore::LocalFrame&, const String& key) final
    {
        String oldValue;
        m_map.removeItem(key, oldValue);
    }

    void clear(WebCore::LocalFrame&) final { m_map.clear(); }

    // No StorageEventDispatcher calls: storage events only target OTHER
    // windows of the same origin, and this embedder has exactly one page.

    WebCore::StorageType m_type;
    WebCore::StorageMap m_map;
};

class BibStorageNamespace final : public WebCore::StorageNamespace {
public:
    static Ref<BibStorageNamespace> create(WebCore::StorageType type, unsigned quota, PAL::SessionID sessionID)
    {
        return adoptRef(*new BibStorageNamespace(type, quota, sessionID));
    }

private:
    BibStorageNamespace(WebCore::StorageType type, unsigned quota, PAL::SessionID sessionID)
        : m_type(type)
        , m_quota(quota)
        , m_sessionID(sessionID)
    {
    }

    Ref<WebCore::StorageArea> storageArea(const WebCore::SecurityOrigin& origin) final
    {
        auto result = m_areas.ensure(origin.data(), [&]() -> RefPtr<WebCore::StorageArea> {
            return adoptRef(*new BibStorageArea(m_type, m_quota));
        });
        // First touch of a LOCAL origin: hydrate from the persistence seed
        // (if a previous session stored anything for it) and register for
        // the dump walk. Opaque origins serialize as "null" — not restorable.
        if (result.isNewEntry && m_type == WebCore::StorageType::Local) {
            auto& area = static_cast<BibStorageArea&>(*result.iterator->value);
            String originKey = origin.data().toString();
            if (!originKey.isEmpty() && originKey != "null"_s) {
                for (auto& [key, value] : bibPendingStorageImport().take(originKey))
                    area.importItem(key, value);
                bibLocalAreaRegistry().set(originKey, &area);
            }
        }
        return *result.iterator->value;
    }

    const WebCore::SecurityOrigin* topLevelOrigin() const final { return nullptr; }

    Ref<WebCore::StorageNamespace> copy(WebCore::Page&) final
    {
        // Session-storage cloning targets a NEW page; this embedder never
        // creates one, so a fresh empty namespace is sufficient.
        return create(m_type, m_quota, m_sessionID);
    }

    PAL::SessionID sessionID() const final { return m_sessionID; }
    void setSessionIDForTesting(PAL::SessionID sessionID) final { m_sessionID = sessionID; }

    WebCore::StorageType m_type;
    unsigned m_quota;
    PAL::SessionID m_sessionID;
    HashMap<WebCore::SecurityOriginData, RefPtr<WebCore::StorageArea>> m_areas;
};

class BibStorageNamespaceProvider final : public WebCore::StorageNamespaceProvider {
public:
    static Ref<BibStorageNamespaceProvider> create()
    {
        return adoptRef(*new BibStorageNamespaceProvider);
    }

private:
    // 5 MB quotas, the HTML5-suggested value WebCore uses for localStorage
    // (storage/StorageNamespaceProvider.cpp).
    static constexpr unsigned sessionQuotaInBytes = 5 * 1024 * 1024;

    Ref<WebCore::StorageNamespace> createLocalStorageNamespace(unsigned quota, PAL::SessionID sessionID) final
    {
        return BibStorageNamespace::create(WebCore::StorageType::Local, quota, sessionID);
    }

    Ref<WebCore::StorageNamespace> createTransientLocalStorageNamespace(WebCore::SecurityOrigin&, unsigned quota, PAL::SessionID sessionID) final
    {
        return BibStorageNamespace::create(WebCore::StorageType::TransientLocal, quota, sessionID);
    }

    RefPtr<WebCore::StorageNamespace> sessionStorageNamespace(const WebCore::SecurityOrigin&, WebCore::Page&, ShouldCreateNamespace shouldCreate) final
    {
        // One session namespace total: areas inside it are already keyed by
        // document origin, and a single-page embedder has one "tab".
        if (!m_sessionNamespace && shouldCreate == ShouldCreateNamespace::Yes)
            m_sessionNamespace = BibStorageNamespace::create(WebCore::StorageType::Session, sessionQuotaInBytes, PAL::SessionID::defaultSessionID());
        return m_sessionNamespace;
    }

    RefPtr<WebCore::StorageNamespace> m_sessionNamespace;
};

} // namespace BIB
