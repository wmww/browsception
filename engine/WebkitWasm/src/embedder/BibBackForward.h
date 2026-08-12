// browsception 2.3: in-memory back/forward list.
//
// pageConfigurationWithEmptyClients installs EmptyBackForwardClient, which
// stores nothing — so history traversal (user back/forward, guest
// history.back()) silently no-ops. This is WebKitLegacy's BackForwardList
// (mac/History/BackForwardList.mm) trimmed to the BackForwardClient
// interface: vector of HistoryItems + current index, capacity-bounded,
// forward list tossed on add.

#pragma once

#include "BackForwardCache.h"
#include "BackForwardClient.h"
#include "HistoryItem.h"
#include <wtf/Vector.h>

namespace BIB {

class BibBackForwardList final : public WebCore::BackForwardClient {
public:
    static Ref<BibBackForwardList> create() { return adoptRef(*new BibBackForwardList); }

    void addItem(Ref<WebCore::HistoryItem>&& newItem) final
    {
        // Toss the forward list.
        if (m_current != notFound) {
            while (m_entries.size() > m_current + 1) {
                Ref item = m_entries.takeLast();
                WebCore::BackForwardCache::singleton().remove(item);
            }
        }
        // Capacity: drop the oldest (legacy semantics).
        if (m_entries.size() == kCapacity && m_current) {
            Ref item = WTF::move(m_entries[0]);
            m_entries.removeAt(0);
            WebCore::BackForwardCache::singleton().remove(item);
            --m_current;
        }
        m_entries.insert(m_current + 1, WTF::move(newItem));
        ++m_current;
    }

    void setChildItem(WebCore::BackForwardFrameItemIdentifier, Ref<WebCore::HistoryItem>&&) final { }

    void goToItem(WebCore::HistoryItem& item) final
    {
        for (size_t i = 0; i < m_entries.size(); ++i) {
            if (m_entries[i].ptr() == &item) {
                m_current = i;
                return;
            }
        }
    }

    Vector<Ref<WebCore::HistoryItem>> allItems(WebCore::FrameIdentifier) final { return m_entries; }

    RefPtr<WebCore::HistoryItem> itemAtIndex(int index, WebCore::FrameIdentifier) final
    {
        // Range checks without math on index (overflow — legacy comment).
        if (index < -static_cast<int>(backListCount()))
            return nullptr;
        if (index > static_cast<int>(forwardListCount()))
            return nullptr;
        return m_entries[index + m_current].copyRef();
    }

    unsigned backListCount() const final { return m_current == notFound ? 0 : m_current; }

    unsigned forwardListCount() const final
    {
        return m_current == notFound ? 0 : m_entries.size() - m_current - 1;
    }

    bool containsItem(const WebCore::HistoryItem& item) const final
    {
        for (auto& entry : m_entries) {
            if (entry.ptr() == &item)
                return true;
        }
        return false;
    }

    void close() final
    {
        m_entries.clear();
        m_current = notFound;
    }

private:
    BibBackForwardList() = default;

    static constexpr size_t kCapacity = 100;
    static constexpr size_t notFound = static_cast<size_t>(-1);

    Vector<Ref<WebCore::HistoryItem>> m_entries;
    size_t m_current { notFound };
};

} // namespace BIB
