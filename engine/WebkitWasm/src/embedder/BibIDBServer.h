// IndexedDB for the raw-Page embedder (root cause #13).
//
// Guest JS touching window.indexedDB on the empty-clients page reaches
// EmptyDatabaseProvider::idbConnectionToServerForSession →
// RELEASE_ASSERT_NOT_REACHED, which unwinds through CLoop and kills the
// calling page's script (discord.com/login goes blank exactly there). The
// fix is the WebKitLegacy recipe: an in-process WebCore::IDBServer::IDBServer
// bridged to the page's IDBConnectionToServer.
//
// This file is Source/WebKitLegacy/Storage/InProcessIDBServer.{h,cpp} at the
// pinned checkout (WebKitLegacy is not part of our build, so the shim moves
// into the embedder), with three adaptations:
//   - includes rewritten <WebCore/X.h> → internal "X.h" (the embedder
//     compiles against WebCore's internal include dirs; there are no
//     forwarding headers in this build);
//   - wrapped in namespace BIB;
//   - dtor tears down inline: the original blocks on a BinarySemaphore
//     waiting for a task on m_queue, but in this single-threaded build every
//     WorkQueue IS the main RunLoop — blocking would deadlock. (In practice
//     BibDatabaseProvider's map holds these Refs for process lifetime.)
//
// The WorkQueue/callOnMainThread hops are kept even though they all land on
// the main RunLoop: IDB client code relies on results arriving AFTER the
// current stack unwinds, which deferred dispatch preserves. The provider
// passes an empty database directory path → MemoryIDBBackingStore: contents
// live for the host-page lifetime, same policy as cookies and web storage.

#pragma once

#include "DatabaseProvider.h"
#include "IDBConnectionToClient.h"
#include "IDBConnectionToServer.h"
#include "IDBIndexIdentifier.h"
#include "IDBIndexInfo.h"
#include "IDBObjectStoreIdentifier.h"
#include "IDBServer.h"
#include <pal/SessionID.h>
#include <wtf/HashMap.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>
#include <wtf/ThreadSafeRefCounted.h>

namespace WTF {
class WorkQueue;
}

namespace BIB {

class InProcessIDBServer final : public WebCore::IDBClient::IDBConnectionToServerDelegate, public WebCore::IDBServer::IDBConnectionToClientDelegate, public ThreadSafeRefCounted<InProcessIDBServer> {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(InProcessIDBServer);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(InProcessIDBServer);
public:
    static Ref<InProcessIDBServer> create(PAL::SessionID);
    static Ref<InProcessIDBServer> create(PAL::SessionID, const String& databaseDirectoryPath);

    virtual ~InProcessIDBServer();

    WebCore::IDBClient::IDBConnectionToServer& connectionToServer() const;
    WebCore::IDBServer::IDBConnectionToClient& connectionToClient() const;
    WebCore::IDBServer::IDBServer& server() { return *m_server; }

    void ref() const final { ThreadSafeRefCounted::ref(); }
    void deref() const final { ThreadSafeRefCounted::deref(); }

    // IDBConnectionToServer
    void deleteDatabase(const WebCore::IDBOpenRequestData&) final;
    void openDatabase(const WebCore::IDBOpenRequestData&) final;
    void abortTransaction(const WebCore::IDBResourceIdentifier&) final;
    void commitTransaction(const WebCore::IDBResourceIdentifier&, uint64_t pendingCountRequest) final;
    void didFinishHandlingVersionChangeTransaction(WebCore::IDBDatabaseConnectionIdentifier, const WebCore::IDBResourceIdentifier&) final;
    void createObjectStore(const WebCore::IDBRequestData&, const WebCore::IDBObjectStoreInfo&) final;
    void deleteObjectStore(const WebCore::IDBRequestData&, const String& objectStoreName) final;
    void renameObjectStore(const WebCore::IDBRequestData&, WebCore::IDBObjectStoreIdentifier, const String& newName) final;
    void clearObjectStore(const WebCore::IDBRequestData&, WebCore::IDBObjectStoreIdentifier) final;
    void createIndex(const WebCore::IDBRequestData&, const WebCore::IDBIndexInfo&) final;
    void deleteIndex(const WebCore::IDBRequestData&, WebCore::IDBObjectStoreIdentifier, const String& indexName) final;
    void renameIndex(const WebCore::IDBRequestData&, WebCore::IDBObjectStoreIdentifier, WebCore::IDBIndexIdentifier, const String& newName) final;
    void putOrAdd(const WebCore::IDBRequestData&, const WebCore::IDBKeyData&, const WebCore::IDBValue&, const WebCore::IndexIDToIndexKeyMap&, const WebCore::IndexedDB::ObjectStoreOverwriteMode) final;
    void getRecord(const WebCore::IDBRequestData&, const WebCore::IDBGetRecordData&) final;
    void getAllRecords(const WebCore::IDBRequestData&, const WebCore::IDBGetAllRecordsData&) final;
    void getCount(const WebCore::IDBRequestData&, const WebCore::IDBKeyRangeData&) final;
    void deleteRecord(const WebCore::IDBRequestData&, const WebCore::IDBKeyRangeData&) final;
    void openCursor(const WebCore::IDBRequestData&, const WebCore::IDBCursorInfo&) final;
    void iterateCursor(const WebCore::IDBRequestData&, const WebCore::IDBIterateCursorData&) final;
    void establishTransaction(WebCore::IDBDatabaseConnectionIdentifier, const WebCore::IDBTransactionInfo&) final;
    void databaseConnectionPendingClose(WebCore::IDBDatabaseConnectionIdentifier) final;
    void databaseConnectionClosed(WebCore::IDBDatabaseConnectionIdentifier) final;
    void abortOpenAndUpgradeNeeded(WebCore::IDBDatabaseConnectionIdentifier, const std::optional<WebCore::IDBResourceIdentifier>& transactionIdentifier) final;
    void didFireVersionChangeEvent(WebCore::IDBDatabaseConnectionIdentifier, const WebCore::IDBResourceIdentifier& requestIdentifier, const WebCore::IndexedDB::ConnectionClosedOnBehalfOfServer) final;
    void didGenerateIndexKeyForRecord(const WebCore::IDBResourceIdentifier& transactionIdentifier, const WebCore::IDBResourceIdentifier& requestIdentifier, const  WebCore::IDBIndexInfo&, const WebCore::IDBKeyData&, const WebCore::IndexKey&, std::optional<int64_t> recordID) final;
    void openDBRequestCancelled(const WebCore::IDBOpenRequestData&) final;
    void getAllDatabaseNamesAndVersions(const WebCore::IDBResourceIdentifier&, const WebCore::ClientOrigin&) final;

    // IDBConnectionToClient
    std::optional<WebCore::IDBConnectionIdentifier> identifier() const final;
    void didDeleteDatabase(const WebCore::IDBResultData&) final;
    void didOpenDatabase(const WebCore::IDBResultData&) final;
    void didAbortTransaction(const WebCore::IDBResourceIdentifier& transactionIdentifier, const WebCore::IDBError&) final;
    void didCommitTransaction(const WebCore::IDBResourceIdentifier& transactionIdentifier, const WebCore::IDBError&) final;
    void didCreateObjectStore(const WebCore::IDBResultData&) final;
    void didDeleteObjectStore(const WebCore::IDBResultData&) final;
    void didRenameObjectStore(const WebCore::IDBResultData&) final;
    void didClearObjectStore(const WebCore::IDBResultData&) final;
    void didCreateIndex(const WebCore::IDBResultData&) final;
    void didDeleteIndex(const WebCore::IDBResultData&) final;
    void didRenameIndex(const WebCore::IDBResultData&) final;
    void didPutOrAdd(const WebCore::IDBResultData&) final;
    void didGetRecord(const WebCore::IDBResultData&) final;
    void didGetAllRecords(const WebCore::IDBResultData&) final;
    void didGetCount(const WebCore::IDBResultData&) final;
    void didDeleteRecord(const WebCore::IDBResultData&) final;
    void didOpenCursor(const WebCore::IDBResultData&) final;
    void didIterateCursor(const WebCore::IDBResultData&) final;
    void fireVersionChangeEvent(WebCore::IDBServer::UniqueIDBDatabaseConnection&, const WebCore::IDBResourceIdentifier& requestIdentifier, uint64_t requestedVersion) final;
    void generateIndexKeyForRecord(const WebCore::IDBResourceIdentifier& requestIdentifier, const WebCore::IDBIndexInfo&, const std::optional<WebCore::IDBKeyPath>&, const WebCore::IDBKeyData&, const WebCore::IDBValue&, std::optional<int64_t> recordID) final;
    void didStartTransaction(const WebCore::IDBResourceIdentifier& transactionIdentifier, const WebCore::IDBError&) final;
    void didCloseFromServer(WebCore::IDBServer::UniqueIDBDatabaseConnection&, const WebCore::IDBError&) final;
    void notifyOpenDBRequestBlocked(const WebCore::IDBResourceIdentifier& requestIdentifier, uint64_t oldVersion, uint64_t newVersion) final;
    void didGetAllDatabaseNamesAndVersions(const WebCore::IDBResourceIdentifier&, Vector<WebCore::IDBDatabaseNameAndVersion>&&) final;

    void closeAndDeleteDatabasesModifiedSince(WallTime);

    void dispatchTask(Function<void()>&&);
    void dispatchTaskReply(Function<void()>&&);

private:
    InProcessIDBServer(PAL::SessionID, const String& databaseDirectoryPath = nullString());

    Lock m_serverLock;
    std::unique_ptr<WebCore::IDBServer::IDBServer> m_server;
    RefPtr<WebCore::IDBClient::IDBConnectionToServer> m_connectionToServer;
    RefPtr<WebCore::IDBServer::IDBConnectionToClient> m_connectionToClient;
    const Ref<WTF::WorkQueue> m_queue;
};

// PageConfiguration provider, modeled on WebKitLegacy's WebDatabaseProvider.
class BibDatabaseProvider final : public WebCore::DatabaseProvider {
public:
    static Ref<BibDatabaseProvider> create() { return adoptRef(*new BibDatabaseProvider); }

    WebCore::IDBClient::IDBConnectionToServer& idbConnectionToServerForSession(PAL::SessionID sessionID) final
    {
        auto result = m_idbServerMap.ensure(sessionID, [sessionID] {
            if (sessionID.isEphemeral())
                return InProcessIDBServer::create(sessionID);
            // Empty directory path → MemoryIDBBackingStore (in-memory,
            // host-page lifetime — same policy as cookies / web storage).
            return InProcessIDBServer::create(sessionID, String());
        });
        return result.iterator->value->connectionToServer();
    }

private:
    BibDatabaseProvider() = default;

    HashMap<PAL::SessionID, RefPtr<InProcessIDBServer>> m_idbServerMap;
};

} // namespace BIB
