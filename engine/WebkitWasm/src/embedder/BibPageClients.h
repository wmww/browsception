// BrowserInBrowser page clients (Phase 3 interactivity).
//
// BibChromeClient: the repaint signal. WebCore's non-composited invalidation
// funnels through ChromeClient::invalidateContentsAndRootView (and the two
// scroll-damage paths) — we fold every damage report into one dirty flag and
// bib_render() repaints the full frame when it's set. ChromeClient::
// scheduleRenderingUpdate() is intentionally NOT overridden: the default
// returns false, which makes RenderingUpdateScheduler fall back to a RunLoop
// timer — and bib_tick() cycles the RunLoop every rAF, so WebCore's own
// rendering updates (in-page rAF, intersection observers) get driven for free.
//
// BibEditorClient: typed text only reaches the DOM through
// EditorClient::handleKeyboardEvent (EmptyEditorClient is final AND inert —
// its should* gates return false, which BLOCKS caret placement and
// insertion). This is the EmptyEditorClient surface copied from
// EmptyClients.cpp with the gates flipped to true and the WinCairo
// WebPage::handleEditingKeyboardEvent logic inlined (minimal command map).

#pragma once

#include "BackForwardController.h"
#include "Document.h"
#include "DocumentLoader.h"
#include "DocumentPage.h" // inline Frame::page() lives here, not in Frame.h
#include "Editor.h"
#include "EditorClient.h"
#include "EmptyClients.h"
#include "EmptyFrameLoaderClient.h"
#include "EventNames.h"
#include "FrameDestructionObserverInlines.h" // inline FrameDestructionObserver::frame()
#include "FrameIdentifier.h"
#include "FrameLoadRequest.h"
#include "FrameLoader.h"
#include "FrameTree.h"
#include "FrameTreeSyncData.h"
#include "HistoryController.h"
#include "HistoryItem.h"
#include "HTMLFrameOwnerElement.h"
#include "KeyboardEvent.h"
#include "LocalFrame.h"
#include "LocalFrameView.h"
#include "MIMETypeRegistry.h"
#include "IntRect.h"
#include "Page.h"
#include "ReferrerPolicy.h"
#include "Node.h"
#include "NodeDocument.h" // inline Node::document()
#include "PlatformKeyboardEvent.h"
#include "ProgressTracker.h"
#include "ProgressTrackerClient.h"
#include "ResourceRequest.h"
#include "StringWithDirection.h"
#include "TextCheckerClient.h"
#include "UserAgent.h"
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <limits>
#include <wtf/JSONValues.h>
#include <wtf/RunLoop.h>
#include <wtf/UniqueRef.h>
#include <wtf/text/WTFString.h>

namespace BIB {

// Set by BibChromeClient on any damage report; cleared by paintFrame().
inline bool g_frameDirty = true;

// Damage LIST, not a single union rect (root-view coords). Scrolling leaves
// two small but DISTANT damages every tick — the exposed strip at the bottom
// and the scrollbar at the right edge — and their single-rect union covered
// ~80% of the frame, so repaint cost stayed ~25ms even with blit-shift
// active (2026-06-11 scroll probe). Disjoint damage must stay disjoint.
// bib_render snapshots the list AFTER layout (layout adds damage), clamps
// each rect to the frame, paints/reads back each region, then resets.
// Slot 0 starts huge so the first paint covers the whole frame.
inline constexpr size_t kMaxDamageRects = 4;
inline WebCore::IntRect g_damageRects[kMaxDamageRects] = { { 0, 0, 1 << 20, 1 << 20 } };
inline size_t g_damageCount = 1;

// Region the HOST canvas must re-upload WITHOUT WebCore repainting it:
// blit-shifted scroll pixels already updated in g_blitPixels + the surface
// by bibScrollBlit. bib_render unions it into the reported dirty box.
inline WebCore::IntRect g_uploadRect;

// Fast-scroll hook installed by main.cpp (shifts surface + blit buffer).
// Null until the engine is up; scroll() falls back to full-clip damage.
inline void (*g_scrollBlit)(const WebCore::IntSize&, const WebCore::IntRect&, const WebCore::IntRect&) = nullptr;

// ?perflog=1 scroll-path tracing (set by main.cpp alongside g_perfLog).
inline bool g_scrollDebug = false;

inline void addDamage(const WebCore::IntRect& rect)
{
    if (rect.isEmpty())
        return;
    g_frameDirty = true;
    // Overlapping (or contained) damage merges in place; a later merge can
    // make two slots overlap each other — harmless, painting is idempotent.
    for (size_t i = 0; i < g_damageCount; ++i) {
        if (g_damageRects[i].contains(rect))
            return;
        if (g_damageRects[i].intersects(rect)) {
            g_damageRects[i].unite(rect);
            return;
        }
    }
    if (g_damageCount < kMaxDamageRects) {
        g_damageRects[g_damageCount++] = rect;
        return;
    }
    // List full: unite into the slot whose union grows the least.
    auto area = [](const WebCore::IntRect& r) {
        return static_cast<int64_t>(r.width()) * r.height();
    };
    size_t best = 0;
    int64_t bestGrowth = std::numeric_limits<int64_t>::max();
    for (size_t i = 0; i < g_damageCount; ++i) {
        WebCore::IntRect u = g_damageRects[i];
        u.unite(rect);
        int64_t growth = area(u) - area(g_damageRects[i]);
        if (growth < bestGrowth) {
            bestGrowth = growth;
            best = i;
        }
    }
    g_damageRects[best].unite(rect);
}

// Set by BibChromeClient::scheduleRenderingUpdate (WebCore requested the
// "update the rendering" steps); consumed once per host display frame by
// bib_tick. Starts true so the boot page gets its first update pass.
inline bool g_renderingUpdateRequested = true;

// browsception 2.3: multiplexed chrome signal to the host page —
// Module.bibChrome(kind, json). Delivery matches the bibPersist pattern:
// strings are decoded + freed inside the EM_ASM, the hook receives JS
// strings. `kind` must be a static string literal (never freed).
inline void emitChrome(const char* kind, const String& json)
{
    CString utf8 = json.utf8();
    char* copy = static_cast<char*>(malloc(utf8.length() + 1));
    if (!copy)
        return;
    memcpy(copy, utf8.data(), utf8.length() + 1);
    MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof growMemViews === "function")
            growMemViews();
        var kind = UTF8ToString($0);
        var json = UTF8ToString($1);
        _bib_wasm_free($1);
        if (typeof Module !== "undefined" && Module && Module.bibChrome)
            Module.bibChrome(kind, json);
    }, kind, copy);
}

// What a navigation did to the back/forward list. The host mirrors the
// engine's history into the REAL tab's session history (browsception
// notes/ui.md), and push-vs-replace is not derivable from the URL alone.
inline const char* navKindForLoadType(WebCore::FrameLoadType type)
{
    switch (type) {
    case WebCore::FrameLoadType::Back:
    case WebCore::FrameLoadType::Forward:
    case WebCore::FrameLoadType::IndexedBackForward:
        return "traverse";
    case WebCore::FrameLoadType::Reload:
    case WebCore::FrameLoadType::ReloadFromOrigin:
    case WebCore::FrameLoadType::ReloadExpiredOnly:
        return "reload";
    case WebCore::FrameLoadType::Standard:
        return "new";
    default:
        // Same / RedirectWithLockedBackForwardList / MultipartReplace /
        // NavigationAPIReplace: current entry overwritten in place.
        return "replace";
    }
}

// "url" signal: true engine URL + traversal state. Fired on commit and on
// within-page navigations (fragment, pushState/replaceState/popstate).
//
// kind/index/length let the host mirror this list into tab history. `index`
// is the current entry's position; on a Standard load the commit fires
// BEFORE the item is added (same staleness as canGoBack below), so the host
// treats a repeat of the same URL as a fixup of the entry it just pushed.
// kindOverride is for the same-document dispatches, where the loader's
// loadType is left over from the last real load.
inline void emitUrlSignal(WebCore::LocalFrame& frame, const char* kindOverride = nullptr)
{
    if (!frame.isMainFrame())
        return;
    RefPtr page = frame.page();
    RefPtr document = frame.document();
    if (!page || !document)
        return;
    auto& backForward = page->backForward();
    auto obj = JSON::Object::create();
    obj->setString("url"_s, document->url().string());
    obj->setBoolean("canGoBack"_s, backForward.canGoBackOrForward(-1));
    obj->setBoolean("canGoForward"_s, backForward.canGoBackOrForward(1));
    obj->setString("kind"_s, String::fromLatin1(kindOverride ? kindOverride : navKindForLoadType(frame.loader().loadType())));
    obj->setInteger("index"_s, static_cast<int>(backForward.backCount()));
    obj->setInteger("length"_s, static_cast<int>(backForward.backCount() + backForward.forwardCount() + 1));
    emitChrome("url", obj->toJSONString());
}

// browsception 2.3: load-progress signals for the viewer's progress bar.
class BibProgressTrackerClient final : public WebCore::ProgressTrackerClient {
private:
    void progressStarted(WebCore::LocalFrame& frame) final { emitProgress(frame, 0.0); }
    void progressEstimateChanged(WebCore::LocalFrame& frame) final
    {
        if (RefPtr page = frame.page())
            emitProgress(frame, page->progress().estimatedProgress());
    }
    void progressFinished(WebCore::LocalFrame& frame) final { emitProgress(frame, 1.0); }

    void emitProgress(WebCore::LocalFrame& frame, double p)
    {
        if (!frame.isMainFrame())
            return;
        auto obj = JSON::Object::create();
        obj->setDouble("p"_s, p);
        emitChrome("progress", obj->toJSONString());
    }
};

class BibChromeClient final : public WebCore::EmptyChromeClient {
public:
    BibChromeClient() = default;

private:
    // invalidateRootView = "push the backing store to the window": the
    // backing store (SkSurface + g_blitPixels) is NOT stale — only the host
    // canvas needs a re-upload. ScrollView::scrollContents fires this with
    // the FULL visible rect on EVERY scroll tick BEFORE ChromeClient::
    // scroll(), so mapping it to addDamage() forced a full-viewport repaint
    // per tick — the REAL blit-shift dormancy root cause (the g_frameDirty
    // guard was just where it surfaced). The Win port maps this to its
    // window-only dirty region the same way (WebView::repaint with
    // contentChanged=false). Content damage arrives separately via
    // invalidateContentsAndRootView / invalidateContentsForSlowScroll.
    void invalidateRootView(const WebCore::IntRect& rect) final { g_uploadRect.unite(rect); }
    void invalidateContentsAndRootView(const WebCore::IntRect& rect) final { addDamage(rect); }
    void invalidateContentsForSlowScroll(const WebCore::IntRect& rect) final
    {
        if (g_scrollDebug)
            WTFLogAlways("BIBSCROLL slow-path invalidate %d,%d %dx%d", rect.x(), rect.y(), rect.width(), rect.height());
        addDamage(rect);
    }
    // scroll() is the fast-scroll path: the embedder blit-shifts the
    // scrolled pixels and repaints only the exposed strips (main.cpp's
    // bibScrollBlit). NOTE: WebCore only takes this path when
    // canBlitOnScroll() — pages with fixed/sticky elements go through the
    // slow full-invalidate path regardless (decision-005 finding 5).
    void scroll(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect) final
    {
        if (g_scrollBlit)
            g_scrollBlit(delta, rectToScroll, clipRect);
        else
            addDamage(clipRect);
    }

    // Returning true takes ownership of driving Page::updateRendering():
    // bib_tick runs it on the next host display frame iff this flag is set.
    // This suppresses RenderingUpdateScheduler's fallback timer — which
    // otherwise DOUBLE-drove update passes (its timer plus bib_tick's old
    // unconditional call) — and stops idle pages from paying a full
    // rendering-update walk on every frame.
    bool scheduleRenderingUpdate() final
    {
        g_renderingUpdateRequested = true;
        return true;
    }

    // Guest-page console + uncaught JS exceptions -> engine stderr
    // (printErr -> "[bib] err:" in the host console). EmptyChromeClient
    // discards these (relaxed final->override, patch ledger), which made
    // every script-dead site an undiagnosable blank page.
    void addMessageToConsole(JSC::MessageSource, JSC::MessageLevel level, const String& message, unsigned lineNumber, unsigned, const String& sourceID) final
    {
        static constexpr const char* levels[] = { "log", "warn", "error", "debug", "info" };
        auto levelIndex = static_cast<size_t>(level);
        // Console spam is real (SPAs log banners); cap per-line payload.
        auto text = message.left(512).utf8();
        auto source = sourceID.right(96).utf8();
        WTFLogAlways("BIB: console %s: %s (%s:%u)",
            levelIndex < std::size(levels) ? levels[levelIndex] : "?",
            text.data(), source.data(), lineNumber);
    }
};

class BibEditorClient final : public WebCore::EditorClient {
public:
    BibEditorClient() = default;

private:
    // Editing gates: EmptyEditorClient returns false from all of these,
    // which disables editing wholesale. We allow everything.
    bool shouldDeleteRange(const std::optional<WebCore::SimpleRange>&) final { return true; }
    bool smartInsertDeleteEnabled() final { return false; }
    bool isSelectTrailingWhitespaceEnabled() const final { return false; }
    bool isContinuousSpellCheckingEnabled() final { return false; }
    void toggleContinuousSpellChecking() final { }
    bool isGrammarCheckingEnabled() final { return false; }
    void toggleGrammarChecking() final { }
    int spellCheckerDocumentTag() final { return -1; }

    bool shouldBeginEditing(const WebCore::SimpleRange&) final { return true; }
    bool shouldEndEditing(const WebCore::SimpleRange&) final { return true; }
    bool shouldInsertNode(WebCore::Node&, const std::optional<WebCore::SimpleRange>&, WebCore::EditorInsertAction) final { return true; }
    bool shouldInsertText(const String&, const std::optional<WebCore::SimpleRange>&, WebCore::EditorInsertAction) final { return true; }
    bool shouldChangeSelectedRange(const std::optional<WebCore::SimpleRange>&, const std::optional<WebCore::SimpleRange>&, WebCore::Affinity, bool) final { return true; }

    bool shouldApplyStyle(const WebCore::StyleProperties&, const std::optional<WebCore::SimpleRange>&) final { return true; }
    void didApplyStyle() final { }
    bool shouldMoveRangeAfterDelete(const WebCore::SimpleRange&, const WebCore::SimpleRange&) final { return true; }

    void didBeginEditing() final { }
    void respondToChangedContents() final { }
    void respondToChangedSelection(WebCore::LocalFrame*) final { }
    void updateEditorStateAfterLayoutIfEditabilityChanged() final { }
    void discardedComposition(const WebCore::Document&) final { }
    void canceledComposition() final { }
    void didUpdateComposition() final { }
    void didEndEditing() final { }
    void didEndUserTriggeredSelectionChanges() final { }
    void willWriteSelectionToPasteboard(const std::optional<WebCore::SimpleRange>&) final { }
    void didWriteSelectionToPasteboard() final { }
    void getClientPasteboardData(const std::optional<WebCore::SimpleRange>&, Vector<std::pair<String, RefPtr<WebCore::SharedBuffer>>>&) final { }
    void requestCandidatesForSelection(const WebCore::VisibleSelection&) final { }
    void handleAcceptedCandidateWithSoftSpaces(WebCore::TextCheckingResult) final { }

    void registerUndoStep(WebCore::UndoStep&) final { }
    void registerRedoStep(WebCore::UndoStep&) final { }
    void clearUndoRedoOperations() final { }

    WebCore::DOMPasteAccessResponse requestDOMPasteAccess(WebCore::DOMPasteAccessCategory, WebCore::FrameIdentifier, const String&) final { return WebCore::DOMPasteAccessResponse::DeniedForGesture; }

    bool canCopyCut(WebCore::LocalFrame*, bool defaultValue) const final { return defaultValue; }
    bool canPaste(WebCore::LocalFrame*, bool defaultValue) const final { return defaultValue; }
    bool canUndo() const final { return false; }
    bool canRedo() const final { return false; }

    void undo() final { }
    void redo() final { }

    void handleKeyboardEvent(WebCore::KeyboardEvent& event) final
    {
        if (handleEditingKeyboardEvent(event))
            event.setDefaultHandled();
    }
    void handleInputMethodKeydown(WebCore::KeyboardEvent&) final { }

    void textFieldDidBeginEditing(WebCore::Element&) final { }
    void textFieldDidEndEditing(WebCore::Element&) final { }
    void textDidChangeInTextField(WebCore::Element&) final { }
    bool doTextFieldCommandFromEvent(WebCore::Element&, WebCore::KeyboardEvent*) final { return false; }
    void textWillBeDeletedInTextField(WebCore::Element&) final { }
    void textDidChangeInTextArea(WebCore::Element&) final { }
    void overflowScrollPositionChanged() final { }
    void subFrameScrollPositionChanged() final { }

    bool performTwoStepDrop(WebCore::DocumentFragment&, const WebCore::SimpleRange&, bool) final { return false; }

    WebCore::TextCheckerClient* textChecker() final { return &m_textCheckerClient; }

    void updateSpellingUIWithGrammarString(const String&, const WebCore::GrammarDetail&) final { }
    void updateSpellingUIWithMisspelledWord(const String&) final { }
    void showSpellingUI(bool) final { }
    bool spellingUIIsShowing() final { return false; }

    void setInputMethodState(WebCore::Element*) final { }

    // Minimal interpretKeyEvent: just the commands the embedder needs for
    // basic field editing. Everything else falls through to text insertion
    // (Char events) or is ignored.
    static const char* commandForKeyDown(const WebCore::PlatformKeyboardEvent& event)
    {
        auto& key = event.key();
        if (key == "Backspace"_s)
            return "DeleteBackward";
        if (key == "Delete"_s)
            return "DeleteForward";
        if (key == "ArrowLeft"_s)
            return event.shiftKey() ? "MoveLeftAndModifySelection" : "MoveLeft";
        if (key == "ArrowRight"_s)
            return event.shiftKey() ? "MoveRightAndModifySelection" : "MoveRight";
        if (key == "ArrowUp"_s)
            return "MoveUp";
        if (key == "ArrowDown"_s)
            return "MoveDown";
        if (key == "Home"_s)
            return "MoveToBeginningOfLine";
        if (key == "End"_s)
            return "MoveToEndOfLine";
        return "";
    }

    static const char* commandForChar(const WebCore::PlatformKeyboardEvent& event)
    {
        if (event.text() == "\r"_s)
            return "InsertNewline";
        if (event.text() == "\t"_s)
            return "InsertTab";
        return "";
    }

    // WinCairo WebPage::handleEditingKeyboardEvent, condensed.
    static bool handleEditingKeyboardEvent(WebCore::KeyboardEvent& event)
    {
        RefPtr targetNode = dynamicDowncast<WebCore::Node>(event.target());
        if (!targetNode)
            return false;
        RefPtr frame = targetNode->document().frame();
        if (!frame)
            return false;

        auto* keyEvent = event.underlyingPlatformEvent();
        if (!keyEvent || keyEvent->isSystemKey())
            return false;
        if (event.type() != WebCore::eventNames().keydownEvent && event.type() != WebCore::eventNames().keypressEvent)
            return false;

        if (keyEvent->type() == WebCore::PlatformEvent::Type::RawKeyDown) {
            auto command = frame->editor().command(String::fromLatin1(commandForKeyDown(*keyEvent)));
            // Leave text-inserting commands to the keypress (Char) event so
            // WebCore can decide (e.g. Tab = focus move vs character).
            return !command.isTextInsertion() && command.execute(&event);
        }

        auto command = frame->editor().command(String::fromLatin1(commandForChar(*keyEvent)));
        if (command.execute(&event))
            return true;

        // Don't insert null or control characters.
        if (event.charCode() < ' ')
            return false;
        return frame->editor().insertText(keyEvent->text(), &event);
    }

    class BibTextCheckerClient final : public WebCore::TextCheckerClient {
        bool shouldEraseMarkersAfterChangeSelection(WebCore::TextCheckingType) const final { return true; }
        void ignoreWordInSpellDocument(const String&) final { }
        void learnWord(const String&) final { }
        void checkSpellingOfString(StringView, int*, int*) final { }
        void checkGrammarOfString(StringView, Vector<WebCore::GrammarDetail>&, int*, int*) final { }
#if USE(UNIFIED_TEXT_CHECKING)
        Vector<WebCore::TextCheckingResult> checkTextOfParagraph(StringView, OptionSet<WebCore::TextCheckingType>, const WebCore::VisibleSelection&) final { return { }; }
#endif
        void getGuessesForWord(const String&, const String&, const WebCore::VisibleSelection&, Vector<String>&) final { }
        void requestCheckingOfString(WebCore::TextCheckingRequest&, const WebCore::VisibleSelection&) final { }
        void requestExtendedCheckingOfString(WebCore::TextCheckingRequest&, const WebCore::VisibleSelection&) final { }
    };

    BibTextCheckerClient m_textCheckerClient;
};

// Wasm shim (decision-006 S-A): registers the __bibWasm2js host-translation
// bridge and evaluates the WebAssembly polyfill in every new window object.
// Implemented in main.cpp (EM_ASM + JSC API live there).
void injectWasmPolyfill(WebCore::LocalFrame&, WebCore::DOMWrapperWorld&);

// BibFrameLoaderClient (Phase 4 networking): EmptyFrameLoaderClient with the
// four "silently dead" load gates fixed (each relaxed final->override in
// EmptyFrameLoaderClient.h, patch ledger):
//   1. policy checks — the empty bodies DROP the FramePolicyFunction, so
//      every navigation stalls forever waiting for a decision;
//   2. canHandleRequest() == false — PolicyChecker refuses every URL;
//   3. canShowMIMEType() == false — content policy rejects every response;
//   4. committedLoad() empty — response bytes never reach the parser.
class BibFrameLoaderClient final : public WebCore::EmptyFrameLoaderClient {
public:
    explicit BibFrameLoaderClient(WebCore::FrameLoader& frameLoader)
        : WebCore::EmptyFrameLoaderClient(frameLoader)
        , m_frameLoader(frameLoader) // base keeps its copy private
    {
    }

private:
    void dispatchDecidePolicyForNavigationAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest&, const WebCore::ResourceResponse&, WebCore::FormState*, const String&, std::optional<WebCore::NavigationIdentifier>, std::optional<WebCore::HitTestResult>&&, bool, WebCore::NavigationUpgradeToHTTPSBehavior, WebCore::SandboxFlags, WebCore::PolicyDecisionMode, WebCore::FramePolicyFunction&& function) final
    {
        function(WebCore::PolicyAction::Use);
    }

    void dispatchDecidePolicyForResponse(const WebCore::ResourceResponse&, const WebCore::ResourceRequest&, const String&, WebCore::FramePolicyFunction&& function) final
    {
        function(WebCore::PolicyAction::Use);
    }

    void dispatchDecidePolicyForNewWindowAction(const WebCore::NavigationAction&, const WebCore::ResourceRequest& request, WebCore::FormState*, const String&, std::optional<WebCore::HitTestResult>&&, WebCore::FramePolicyFunction&& function) final
    {
        // Single-page embedder: no window can ever open — but the old plain
        // Ignore made every target=_blank link a silent no-op (a very common
        // dead end: login flows, docs links). Retarget the navigation into
        // the MAIN frame instead, asynchronously so the loader re-enters
        // from a clean stack, not from inside this policy callback.
        if (request.url().protocolIsInHTTPFamily()) {
            WTF::RunLoop::mainSingleton().dispatch([frame = Ref { m_frameLoader->frame() }, url = request.url().isolatedCopy()]() mutable {
                RefPtr page = frame->page();
                RefPtr mainFrame = page ? page->localMainFrame() : nullptr;
                if (!mainFrame)
                    return;
                WebCore::FrameLoadRequest loadRequest { *mainFrame, WebCore::ResourceRequest { WTF::move(url) } };
                mainFrame->loader().load(WTF::move(loadRequest));
            });
        }
        function(WebCore::PolicyAction::Ignore);
    }

    bool canHandleRequest(const WebCore::ResourceRequest&) const final { return true; }

    // browsception 2.3 chrome signals (finals relaxed in
    // EmptyFrameLoaderClient.h, patch ledger): true-URL + traversal state on
    // every committed or within-page navigation, and the document title.
    void dispatchDidCommitLoad(std::optional<WebCore::HasInsecureContent>, std::optional<WebCore::UsedLegacyTLS>, std::optional<WebCore::WasPrivateRelayed>) final
    {
        emitUrlSignal(m_frameLoader->frame());
    }
    // History exists at all only because of this factory: the empty client
    // returns nullptr, so HistoryController never creates items and every
    // traversal silently no-ops. Delegation identical to WebKit2's
    // WebLocalFrameLoaderClient (final relaxed, patch ledger).
    RefPtr<WebCore::HistoryItem> createHistoryItemTree(bool clipAtTarget, WebCore::BackForwardItemIdentifier itemID) const final
    {
        Ref frame = m_frameLoader->frame();
        return frame->loader().history().createItemTree(frame, clipAtTarget, itemID);
    }

    // …and traversal works only because of this: the empty client VETOES
    // every history navigation (ShouldGoToHistoryItem::No). Single-process
    // embedder: always allow (final relaxed, patch ledger).
    WebCore::ShouldGoToHistoryItem shouldGoToHistoryItem(WebCore::HistoryItem&, WebCore::IsSameDocumentNavigation, WebCore::ProcessSwapDisposition) const final
    {
        return WebCore::ShouldGoToHistoryItem::Yes;
    }

    // Commit fires BEFORE the HistoryItem for the new page is added, so the
    // canGoBack/canGoForward computed there is one navigation stale; re-emit
    // once the load finishes (history updated by then).
    void dispatchDidFinishLoad() final { emitUrlSignal(m_frameLoader->frame()); }
    void dispatchDidChangeLocationWithinPage() final { emitUrlSignal(m_frameLoader->frame()); }
    void dispatchDidPushStateWithinPage() final { emitUrlSignal(m_frameLoader->frame(), "new"); }
    void dispatchDidReplaceStateWithinPage() final { emitUrlSignal(m_frameLoader->frame(), "replace"); }
    // Fires for BOTH a fragment navigation (new entry, already added) and a
    // same-document traversal; loadType tells them apart (loadItem sets it
    // before loadSameDocumentItem), so no override here.
    void dispatchDidPopStateWithinPage() final { emitUrlSignal(m_frameLoader->frame()); }
    void dispatchDidReceiveTitle(const WebCore::StringWithDirection& title) final
    {
        if (!m_frameLoader->frame().isMainFrame())
            return;
        auto obj = JSON::Object::create();
        obj->setString("title"_s, title.string);
        emitChrome("title", obj->toJSONString());
    }

    // Wasm shim injection point (decision-006 S-A): fires once per new
    // document window, before any author script runs — the same hook every
    // real port uses for window-object setup (relaxed final->override in
    // EmptyFrameLoaderClient.h, patch ledger). Covers subframes too: every
    // frame gets a BibFrameLoaderClient.
    void dispatchDidClearWindowObjectInWorld(WebCore::DOMWrapperWorld& world) final
    {
        injectWasmPolyfill(m_frameLoader->frame(), world);
    }

    bool canShowMIMEType(const String& mimeType) const final
    {
        return WebCore::MIMETypeRegistry::canShowMIMEType(mimeType);
    }

    void committedLoad(WebCore::DocumentLoader* loader, const WebCore::SharedBuffer& data) final
    {
        loader->commitData(data);
    }

    String userAgent(const URL&) const final
    {
        return WebCore::standardUserAgent();
    }

    // Subframe creation (root cause #12, empty-clients family): the empty
    // client returns nullptr, so every <iframe> got a null contentWindow —
    // discord.com's bootstrap dies on exactly that (relaxed final->override
    // in EmptyFrameLoaderClient.h, patch ledger). Recipe condensed from
    // WebKitLegacy WebFrame.mm _createFrameWithPage.
    RefPtr<WebCore::LocalFrame> createFrame(const AtomString& name, WebCore::HTMLFrameOwnerElement& ownerElement) final
    {
        RefPtr ownerFrame = ownerElement.document().frame();
        if (!ownerFrame)
            return nullptr;
        RefPtr page = ownerFrame->page();
        if (!page)
            return nullptr;

        auto effectiveSandboxFlags = ownerElement.sandboxFlags();
        effectiveSandboxFlags.add(ownerFrame->effectiveSandboxFlags());
        auto effectiveReferrerPolicy = ownerElement.referrerPolicy();
        if (RefPtr localTopDocument = page->localTopDocument(); effectiveReferrerPolicy == WebCore::ReferrerPolicy::EmptyString && localTopDocument)
            effectiveReferrerPolicy = localTopDocument->referrerPolicy();

        auto subframe = WebCore::LocalFrame::createSubframe(*page, [](auto&, auto& frameLoader) -> UniqueRef<WebCore::LocalFrameLoaderClient> {
            return WTF::makeUniqueRefWithoutRefCountedCheck<BibFrameLoaderClient>(frameLoader);
        }, WebCore::generateFrameIdentifier(), effectiveSandboxFlags, effectiveReferrerPolicy, ownerElement, WebCore::FrameTreeSyncData::create());
        subframe->tree().setSpecifiedName(name);
        subframe->init();

        // init() runs script synchronously (initial about:blank document) —
        // it may have removed the frame from the page already.
        if (!subframe->page())
            return nullptr;
        return subframe;
    }

    // Every real port replaces the frame's view on each committed
    // navigation (WebKit2 WebLocalFrameLoaderClient recipe); the empty
    // client's no-op made us silently REUSE the boot-time view across
    // in-engine navigations (stale scroll/paint state) and left subframes
    // with no view at all (relaxed final->override, patch ledger).
    void transitionToCommittedForNewPage(InitializingIframe) final
    {
        Ref frame = m_frameLoader->frame();
        RefPtr oldView = frame->view();
        // Main frame keeps the embedder's fixed canvas size; subframes are
        // sized by layout (LocalFrame::createView auto-sizes non-root).
        // canHaveScrollbars carries over so main.cpp's boot-time choice
        // (off in gate mode — byte-stable pixel gates) survives navigation.
        WebCore::IntSize size = oldView ? oldView->size() : WebCore::IntSize();
        bool canHaveScrollbars = oldView ? oldView->canHaveScrollbars() : true;
        frame->createView(size, std::nullopt, { }, false);
        if (RefPtr view = frame->view())
            view->setCanHaveScrollbars(canHaveScrollbars);
    }

    WeakRef<WebCore::FrameLoader> m_frameLoader;
};

} // namespace BIB
