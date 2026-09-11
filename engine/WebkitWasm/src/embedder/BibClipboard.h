// Clipboard bridge (browsception plans/clipboard.md → notes/rendering-input.md
// § Clipboard). WebCore's pasteboard is an in-memory store
// (platform/emscripten/PasteboardEmscripten.h, in the WebKit patch); this
// file connects it to the host:
//   engine → host: every WebCore-side store write (a Copy/Cut command,
//     execCommand('copy'), a copy handler's setData, navigator.clipboard
//     writes) marks the store dirty; bib_tick emits ONE bibChrome
//     "clipboard" signal per dirty tick, which the viewer writes to the real
//     clipboard under the user activation that caused it.
//   host → engine: the clipboard verbs of bib_edit. copy/cut run the editor
//     command (the key map runs the same commands for Ctrl/Cmd+C/X); paste
//     replaces the store with what the host's paste event carried, then runs
//     Paste, which fires the guest's paste event first.
#pragma once

#include "BibPageClients.h" // emitChrome
#include "Editor.h"
#include "FocusController.h"
#include "LocalFrame.h"
#include "Page.h"
#include "SharedBuffer.h"
#include "UserGestureIndicator.h"
#include "emscripten/PasteboardEmscripten.h"
#include <wtf/JSONValues.h>

namespace BIB {

inline bool g_clipboardDirty = false;

inline void installClipboardObserver()
{
    WebCore::EmscriptenPasteboardStore::singleton().writeObserver = [] { g_clipboardDirty = true; };
}

// Bytes beyond this stay engine-side (a guest can put anything on its own
// clipboard; the host write is best-effort anyway).
constexpr size_t kClipboardSignalMaxBytes = 32 * 1024 * 1024;

// "clipboard" {"items":[{"type","text"} | {"type","name","ptr","len"}]}.
// Binary items are engine-malloc'd; the host copies and frees them.
inline void flushClipboardSignal()
{
    if (!std::exchange(g_clipboardDirty, false))
        return;
    auto items = JSON::Array::create();
    size_t budget = kClipboardSignalMaxBytes;
    for (auto& entry : WebCore::EmscriptenPasteboardStore::singleton().entries()) {
        auto item = JSON::Object::create();
        item->setString("type"_s, entry.type);
        if (entry.bytes) {
            auto span = entry.bytes->span();
            if (span.size() > budget)
                continue;
            auto* copy = static_cast<uint8_t*>(malloc(std::max<size_t>(span.size(), 1)));
            if (!copy)
                continue;
            memcpySpan(std::span { copy, span.size() }, span);
            budget -= span.size();
            item->setInteger("ptr"_s, static_cast<int>(reinterpret_cast<uintptr_t>(copy)));
            item->setInteger("len"_s, static_cast<int>(span.size()));
            if (!entry.name.isEmpty())
                item->setString("name"_s, entry.name);
        } else {
            if (entry.text.length() > budget)
                continue;
            budget -= entry.text.length();
            item->setString("text"_s, entry.text);
        }
        items->pushObject(WTF::move(item));
    }
    auto obj = JSON::Object::create();
    obj->setArray("items"_s, WTF::move(items));
    emitChrome("clipboard", obj->toJSONString());
}

// Host-sourced paste payload → store entries. Items: {"type","text"} or
// {"type","name","off","len"} naming a range of `bytes`.
inline Vector<WebCore::EmscriptenPasteboardStore::Entry> pasteEntries(const JSON::Object& msg, std::span<const uint8_t> bytes)
{
    Vector<WebCore::EmscriptenPasteboardStore::Entry> entries;
    auto items = msg.getArray("items"_s);
    if (!items)
        return entries;
    for (auto& value : *items) {
        auto item = value->asObject();
        if (!item)
            continue;
        auto type = item->getString("type"_s);
        if (type.isEmpty())
            continue;
        if (auto text = item->getString("text"_s); !text.isNull()) {
            entries.append({ type, text, nullptr, { } });
            continue;
        }
        auto off = item->getInteger("off"_s).value_or(-1);
        auto len = item->getInteger("len"_s).value_or(-1);
        if (off < 0 || len < 0 || static_cast<size_t>(off) + static_cast<size_t>(len) > bytes.size())
            continue;
        entries.append({ type, { }, WebCore::SharedBuffer::create(bytes.subspan(off, len)), item->getString("name"_s) });
    }
    return entries;
}

// The clipboard verbs of bib_edit. Returns false for an op it doesn't own.
inline bool runClipboardOp(WebCore::Page& page, const String& op, const JSON::Object& msg, std::span<const uint8_t> bytes)
{
    const char* command = nullptr;
    if (op == "copy"_s)
        command = "Copy";
    else if (op == "cut"_s)
        command = "Cut";
    else if (op == "paste"_s) {
        // Host-sourced: replaces the store without a "clipboard" echo.
        auto entries = pasteEntries(msg, bytes);
        if (entries.isEmpty())
            return true; // nothing we can paste: an empty paste would delete the selection
        WebCore::EmscriptenPasteboardStore::singleton().replaceFromHost(WTF::move(entries));
        command = msg.getBoolean("plain"_s).value_or(false) ? "PasteAsPlainText" : "Paste";
    } else
        return false;
    RefPtr frame = page.focusController().focusedOrMainFrame();
    if (!frame)
        return true;
    // A menu item / OSK button / paste key: user-initiated, like the keys.
    WebCore::UserGestureIndicator gesture(WebCore::IsProcessingUserGesture::Yes, frame->document());
    frame->editor().command(String::fromLatin1(command)).execute();
    return true;
}

} // namespace BIB
