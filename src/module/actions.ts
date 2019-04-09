import { isArray, isPlainObject, isFunction, isNumber } from 'is-what'
import copy from 'copy-anything'
import merge from 'merge-anything'
import flatten from 'flatten-anything'
import { compareObjectProps } from 'compare-anything'
import { AnyObject, IPluginState } from '../declarations'
import setDefaultValues from '../utils/setDefaultValues'
import startDebounce from '../utils/debounceHelper'
import { makeBatchFromSyncstack, createFetchIdentifier } from '../utils/apiHelpers'
import { getId, getValueFromPayloadPiece } from '../utils/payloadHelpers'
import error from './errors'

/**
 * A function returning the actions object
 *
 * @export
 * @param {*} Firebase The Firebase dependency
 * @returns {AnyObject} the actions object
 */
export default function (Firebase: any): AnyObject {
  return {
    setUserId: ({commit, getters}, userId) => {
      if (userId === undefined) userId = null
      // undefined cannot be synced to firestore
      if (!userId && Firebase.auth().currentUser) {
        userId = Firebase.auth().currentUser.uid
      }
      commit('SET_USER_ID', userId)
      if (getters.firestorePathComplete.includes('{userId}')) {
        const error = '[vuex-easy-firestore] error trying to set userId.\n Try doing \`dispatch(\'module/setUserId\', userId)\ before openDBChannel or fetchAndAdd.`'
        console.error(error)
        throw error
      }
    },
    clearUser: ({commit}) => {
      commit('CLEAR_USER')
    },
    setPathVars: ({commit}, pathVars) => {
      commit('SET_PATHVARS', pathVars)
    },
    duplicate: async ({state, getters, commit, dispatch}, id) => {
      if (!getters.collectionMode) return console.error('[vuex-easy-firestore] You can only duplicate in \'collection\' mode.')
      if (!id) return {}
      const doc = merge(getters.storeRef[id], {id: null})
      const dId = await dispatch('insert', doc)
      const idMap = {[id]: dId}
      return idMap
    },
    duplicateBatch ({state, getters, commit, dispatch}, ids = []) {
      if (!getters.collectionMode) return console.error('[vuex-easy-firestore] You can only duplicate in \'collection\' mode.')
      if (!isArray(ids) || !ids.length) return {}
      const idsMap = ids.reduce(async (carry, id) => {
        const idMap = await dispatch('duplicate', id)
        carry = await carry
        return Object.assign(carry, idMap)
      }, {})
      return idsMap
    },
    patchDoc (
      {state, getters, commit, dispatch},
      {id = '', ids = [], doc}: {id?: string, ids?: string[], doc?: AnyObject} = {ids: [], doc: {}}
    ) {
      // 0. payload correction (only arrays)
      if (!isArray(ids)) return console.error('[vuex-easy-firestore] ids needs to be an array')
      if (id) ids.push(id)

      // EXTRA: check if doc is being inserted if so
      state._sync.syncStack.inserts.forEach((newDoc, newDocIndex) => {
        // get the index of the id that is also in the insert stack
        const indexIdInInsert = ids.indexOf(newDoc.id)
        if (indexIdInInsert === -1) return
        // the doc trying to be synced is also in insert
        // prepare the doc as new doc:
        const patchDoc = getters.prepareForInsert([doc])[0]
        // replace insert sync stack with merged item:
        state._sync.syncStack.inserts[newDocIndex] = merge(newDoc, patchDoc)
        // empty out the id that was to be patched:
        ids.splice(indexIdInInsert, 1)
      })

      // 1. Prepare for patching
      const syncStackItems = getters.prepareForPatch(ids, doc)

      // 2. Push to syncStack
      Object.keys(syncStackItems).forEach(id => {
        const newVal = (!state._sync.syncStack.updates[id])
          ? syncStackItems[id]
          : merge(state._sync.syncStack.updates[id], syncStackItems[id])
        state._sync.syncStack.updates[id] = newVal
      })

      // 3. Create or refresh debounce
      return dispatch('handleSyncStackDebounce')
    },
    deleteDoc (
      {state, getters, commit, dispatch},
      ids = []
    ) {
      // 0. payload correction (only arrays)
      if (!isArray(ids)) ids = [ids]

      // 1. Prepare for patching
      // 2. Push to syncStack
      const deletions = state._sync.syncStack.deletions.concat(ids)
      state._sync.syncStack.deletions = deletions

      if (!state._sync.syncStack.deletions.length) return
      // 3. Create or refresh debounce
      return dispatch('handleSyncStackDebounce')
    },
    deleteProp (
      {state, getters, commit, dispatch},
      path
    ) {
      // 1. Prepare for patching
      const syncStackItem = getters.prepareForPropDeletion(path)

      // 2. Push to syncStack
      Object.keys(syncStackItem).forEach(id => {
        const newVal = (!state._sync.syncStack.propDeletions[id])
          ? syncStackItem[id]
          : merge(state._sync.syncStack.propDeletions[id], syncStackItem[id])
        state._sync.syncStack.propDeletions[id] = newVal
      })

      // 3. Create or refresh debounce
      return dispatch('handleSyncStackDebounce')
    },
    insertDoc (
      {state, getters, commit, dispatch},
      docs = []
    ) {
      // 0. payload correction (only arrays)
      if (!isArray(docs)) docs = [docs]

      // 1. Prepare for patching
      const syncStack = getters.prepareForInsert(docs)

      // 2. Push to syncStack
      const inserts = state._sync.syncStack.inserts.concat(syncStack)
      state._sync.syncStack.inserts = inserts

      // 3. Create or refresh debounce
      dispatch('handleSyncStackDebounce')
      return docs.map(d => d.id)
    },
    insertInitialDoc ({state, getters, commit, dispatch}) {
      // 0. only docMode
      if (getters.collectionMode) return

      // 1. Prepare for insert
      const initialDoc = (getters.storeRef) ? getters.storeRef : {}
      const initialDocPrepared = getters.prepareInitialDocForInsert(initialDoc)

      // 2. Create a reference to the SF doc.
      var initialDocRef = getters.dbRef
      return Firebase.firestore().runTransaction(transaction => {
        // This code may get re-run multiple times if there are conflicts.
        return transaction.get(initialDocRef)
          .then(foundInitialDoc => {
            if (!foundInitialDoc.exists) {
              transaction.set(initialDocRef, initialDocPrepared)
            }
          })
      }).then(function() {
        if (state._conf.logging) {
          console.log('[vuex-easy-firestore] Initial doc succesfully inserted.')
        }
      }).catch(function(error) {
        console.error('[vuex-easy-firestore] Initial doc succesfully insertion failed. Further `set` or `patch` actions will also fail. Requires an internet connection when the initial doc is inserted. Please connect to the internet and refresh the page.', error)
      })
    },
    handleSyncStackDebounce ({state, commit, dispatch, getters}) {
      if (!getters.signedIn) return false
      if (!state._sync.syncStack.debounceTimer) {
        const ms = state._conf.sync.debounceTimerMs
        const debounceTimer = startDebounce(ms)
        debounceTimer.done.then(_ => dispatch('batchSync'))
        state._sync.syncStack.debounceTimer = debounceTimer
      }
      state._sync.syncStack.debounceTimer.refresh()
    },
    batchSync ({getters, commit, dispatch, state}) {
      const batch = makeBatchFromSyncstack(state, getters, Firebase)
      dispatch('_startPatching')
      state._sync.syncStack.debounceTimer = null
      return new Promise((resolve, reject) => {
        batch.commit().then(_ => {
          const remainingSyncStack = Object.keys(state._sync.syncStack.updates).length +
            state._sync.syncStack.deletions.length +
            state._sync.syncStack.inserts.length +
            state._sync.syncStack.propDeletions.length
          if (remainingSyncStack) { dispatch('batchSync') }
          dispatch('_stopPatching')
          return resolve()
        }).catch(error => {
          state._sync.patching = 'error'
          state._sync.syncStack.debounceTimer = null
          console.error('Error during synchronisation ↓')
          Error(error)
          return reject(error)
        })
      })
    },
    fetch (
      {state, getters, commit, dispatch},
      pathVariables: AnyObject = {where: [], whereFilters: [], orderBy: []}
      // where: [['archived', '==', true]]
      // orderBy: ['done_date', 'desc']
    ) {
      dispatch('setUserId')
      let {where, whereFilters, orderBy} = pathVariables
      if (!isArray(where)) where = []
      if (!isArray(orderBy)) orderBy = []
      if (isArray(whereFilters) && whereFilters.length) where = whereFilters // depreciated
      if (pathVariables && isPlainObject(pathVariables)) {
        commit('SET_PATHVARS', pathVariables)
      }
      return new Promise((resolve, reject) => {
        // log
        if (state._conf.logging) {
          console.log(`%c fetch for Firestore PATH: ${getters.firestorePathComplete} [${state._conf.firestorePath}]`, 'color: lightcoral')
        }
        if (!getters.signedIn) return resolve()
        const identifier = createFetchIdentifier({where, orderBy})
        const fetched = state._sync.fetched[identifier]
        // We've never fetched this before:
        if (!fetched) {
          let ref = getters.dbRef
          // apply where filters and orderBy
          getters.getWhereArrays(where).forEach(paramsArr => {
            ref = ref.where(...paramsArr)
          })
          if (orderBy.length) ref = ref.orderBy(...orderBy)
          state._sync.fetched[identifier] = {
            ref,
            done: false,
            retrievedFetchRefs: [],
            nextFetchRef: null
          }
        }
        const fRequest = state._sync.fetched[identifier]
        // We're already done fetching everything:
        if (fRequest.done) {
          if (state._conf.logging) console.log('[vuex-easy-firestore] done fetching')
          return resolve({done: true})
        }
        // attach fetch filters
        let fRef = state._sync.fetched[identifier].ref
        if (fRequest.nextFetchRef) {
          // get next ref if saved in state
          fRef = state._sync.fetched[identifier].nextFetchRef
        }
        // add doc limit
        let limit = (isNumber(pathVariables.limit))
          ? pathVariables.limit
          : state._conf.fetch.docLimit
        if (limit > 0) fRef = fRef.limit(limit)
        // Stop if all records already fetched
        if (fRequest.retrievedFetchRefs.includes(fRef)) {
          console.error('[vuex-easy-firestore] Already retrieved this part.')
          return resolve()
        }
        // make fetch request
        fRef.get().then(querySnapshot => {
          const docs = querySnapshot.docs
          if (docs.length === 0) {
            state._sync.fetched[identifier].done = true
            querySnapshot.done = true
            return resolve(querySnapshot)
          }
          if (docs.length < limit) {
            state._sync.fetched[identifier].done = true
          }
          state._sync.fetched[identifier].retrievedFetchRefs.push(fRef)
          // Get the last visible document
          resolve(querySnapshot)
          const lastVisible = docs[docs.length - 1]
          // set the reference for the next records.
          const next = fRef.startAfter(lastVisible)
          state._sync.fetched[identifier].nextFetchRef = next
        }).catch(error => {
          console.error('[vuex-easy-firestore]', error)
          return reject(error)
        })
      })
    },
    fetchAndAdd (
      {state, getters, commit, dispatch},
      pathVariables = {where: [], whereFilters: [], orderBy: []}
      // where: [['archived', '==', true]]
      // orderBy: ['done_date', 'desc']
    ) {
      if (pathVariables && isPlainObject(pathVariables)) {
        commit('SET_PATHVARS', pathVariables)
      }
      // 'doc' mode:
      if (!getters.collectionMode) {
        dispatch('setUserId')
        if (state._conf.logging) {
          console.log(`%c fetch for Firestore PATH: ${getters.firestorePathComplete} [${state._conf.firestorePath}]`, 'color: lightcoral')
        }
        return getters.dbRef.get().then(async _doc => {
          if (!_doc.exists) {
            // No initial doc found in docMode
            if (state._conf.sync.preventInitialDocInsertion) throw 'preventInitialDocInsertion'
            if (state._conf.logging) console.log('[vuex-easy-firestore] inserting initial doc')
            await dispatch('insertInitialDoc')
            return _doc
          }
          const id = getters.docModeId
          const doc = getters.cleanUpRetrievedDoc(_doc.data(), id)
          dispatch('applyHooksAndUpdateState', {change: 'modified', id, doc})
          return doc
        }).catch(error => {
          console.error('[vuex-easy-firestore]', error)
          return error
        })
      }
      // 'collection' mode:
      return dispatch('fetch', pathVariables)
        .then(querySnapshot => {
          if (querySnapshot.done === true) return querySnapshot
          if (isFunction(querySnapshot.forEach)) {
            querySnapshot.forEach(_doc => {
              const id = _doc.id
              const doc = getters.cleanUpRetrievedDoc(_doc.data(), id)
              dispatch('applyHooksAndUpdateState', {change: 'added', id, doc})
            })
          }
          return querySnapshot
        })
    },
    applyHooksAndUpdateState ( // this is only on server retrievals
      {getters, state, commit, dispatch},
      {change, id, doc = {}}: {change: 'added' | 'removed' | 'modified', id: string, doc: AnyObject}
    ) {
      const store = this
      // define storeUpdateFn()
      function storeUpdateFn (_doc) {
        switch (change) {
          case 'added':
            commit('INSERT_DOC', _doc)
            break
          case 'removed':
            commit('DELETE_DOC', id)
            break
          default:
            dispatch('deleteMissingProps', _doc)
            commit('PATCH_DOC', _doc)
            break
        }
      }
      // get user set sync hook function
      const syncHookFn = state._conf.serverChange[change + 'Hook']
      if (isFunction(syncHookFn)) {
        syncHookFn(storeUpdateFn, doc, id, store, 'server', change)
      } else {
        storeUpdateFn(doc)
      }
    },
    deleteMissingProps ({getters, commit}, doc) {
      const defaultValues = getters.defaultValues
      const searchTarget = (getters.collectionMode)
        ? getters.storeRef[doc.id]
        : getters.storeRef
      const compareInfo = compareObjectProps(
        flatten(doc), // presentIn 0
        flatten(defaultValues), // presentIn 1
        flatten(searchTarget) // presentIn 2
      )
      Object.keys(compareInfo.presentIn).forEach(prop => {
        // don't worry about props not in fillables
        if (getters.fillables.length && !getters.fillables.includes(prop)) {
          return
        }
        // don't worry about props in guard
        if (getters.guard.includes(prop)) return
        // don't worry about props starting with _sync or _conf
        if (prop.split('.')[0] === '_sync' || prop.split('.')[0] === '_conf') return
        // where is the prop present?
        const presence = compareInfo.presentIn[prop]
        const propNotInDoc = (!presence.includes(0))
        const propNotInDefaultValues = (!presence.includes(1))
        // delete props that are not present in the doc and default values
        if (propNotInDoc && propNotInDefaultValues) {
          const path = (getters.collectionMode)
            ? `${doc.id}.${prop}`
            : prop
          return commit('DELETE_PROP', path)
        }
      })
    },
    openDBChannel ({getters, state, commit, dispatch}, pathVariables) {
      dispatch('setUserId')
      const store = this
      // set state for pathVariables
      if (pathVariables && isPlainObject(pathVariables)) {
        commit('SET_SYNCFILTERS', pathVariables)
        delete pathVariables.where
        delete pathVariables.orderBy
        commit('SET_PATHVARS', pathVariables)
      }
      const identifier = createFetchIdentifier({
        where: state._conf.sync.where,
        orderBy: state._conf.sync.orderBy,
        pathVariables: state._sync.pathVariables
      })
      if (isFunction(state._sync.unsubscribe[identifier])) {
        const channelAlreadyOpenError = `openDBChannel was already called for these filters and pathvariables. Identifier: ${identifier}`
        if (state._conf.logging) {
          console.log(channelAlreadyOpenError)
        }
        return new Promise((resolve, reject) => { reject(channelAlreadyOpenError) })
      }
      // getters.dbRef should already have pathVariables swapped out
      let dbRef = getters.dbRef
      // apply where filters and orderBy
      if (getters.collectionMode) {
        getters.getWhereArrays().forEach(whereParams => {
          dbRef = dbRef.where(...whereParams)
        })
        if (state._conf.sync.orderBy.length) {
          dbRef = dbRef.orderBy(...state._conf.sync.orderBy)
        }
      }
      // make a promise
      return new Promise((resolve, reject) => {
        // log
        if (state._conf.logging) {
          console.log(`%c openDBChannel for Firestore PATH: ${getters.firestorePathComplete} [${state._conf.firestorePath}]`, 'color: lightcoral')
        }
        const unsubscribe = dbRef.onSnapshot(async querySnapshot => {
          const source = querySnapshot.metadata.hasPendingWrites ? 'local' : 'server'
          // 'doc' mode:
          if (!getters.collectionMode) {
            if (!querySnapshot.data()) {
              // No initial doc found in docMode
              if (state._conf.sync.preventInitialDocInsertion) return reject('preventInitialDocInsertion')
              if (state._conf.logging) console.log('[vuex-easy-firestore] inserting initial doc')
              await dispatch('insertInitialDoc')
              return resolve()
            }
            if (source === 'local') return resolve()
            const id = getters.docModeId
            const doc = getters.cleanUpRetrievedDoc(querySnapshot.data(), id)
            dispatch('applyHooksAndUpdateState', {change: 'modified', id, doc})
            return resolve()
          }
          // 'collection' mode:
          querySnapshot.docChanges().forEach(change => {
            const changeType = change.type
            // Don't do anything for local modifications & removals
            if (source === 'local' && changeType !== 'added') return resolve()
            const id = change.doc.id
            const doc = getters.cleanUpRetrievedDoc(change.doc.data(), id)
            dispatch('applyHooksAndUpdateState', {change: changeType, id, doc})
          })
          return resolve()
        }, error => {
          state._sync.patching = 'error'
          return reject(error)
        })
        state._sync.unsubscribe[identifier] = unsubscribe
      })
    },
    closeDBChannel ({getters, state, commit, dispatch}, { clearModule = false } = { clearModule: false }) {
      const identifier = createFetchIdentifier({
        where: state._conf.sync.where,
        orderBy: state._conf.sync.orderBy,
        pathVariables: state._sync.pathVariables
      })
      const unsubscribeDBChannel = state._sync.unsubscribe[identifier]
      if (isFunction(unsubscribeDBChannel)) {
        unsubscribeDBChannel()
        state._sync.unsubscribe[identifier] = null
      }
      if (clearModule) {
        commit('RESET_VUEX_EASY_FIRESTORE_STATE')
      }
    },
    set ({commit, dispatch, getters, state}, doc) {
      if (!doc) return
      if (!getters.collectionMode) {
        return dispatch('patch', doc)
      }
      const id = getId(doc)
      if (
        !id ||
        (!state._conf.statePropName && !state[id]) ||
        (state._conf.statePropName && !state[state._conf.statePropName][id])
      ) {
        return dispatch('insert', doc)
      }
      return dispatch('patch', doc)
    },
    insert ({state, getters, commit, dispatch}, doc) {
      const store = this
      // check payload
      if (!doc) return
      // check userId
      dispatch('setUserId')
      const newDoc = doc
      if (!newDoc.id) newDoc.id = getters.dbRef.doc().id
      // apply default values
      const newDocWithDefaults = setDefaultValues(newDoc, state._conf.sync.defaultValues)
      // define the store update
      function storeUpdateFn (_doc) {
        commit('INSERT_DOC', _doc)
        return dispatch('insertDoc', _doc)
      }
      // check for hooks
      if (state._conf.sync.insertHook) {
        state._conf.sync.insertHook(storeUpdateFn, newDocWithDefaults, store)
        return newDocWithDefaults.id
      }
      storeUpdateFn(newDocWithDefaults)
      return newDocWithDefaults.id
    },
    insertBatch ({state, getters, commit, dispatch}, docs) {
      const store = this
      // check payload
      if (!isArray(docs) || !docs.length) return []
      // check userId
      dispatch('setUserId')
      const newDocs = docs.reduce((carry, _doc) => {
        const newDoc = getValueFromPayloadPiece(_doc)
        if (!newDoc.id) newDoc.id = getters.dbRef.doc().id
        carry.push(newDoc)
        return carry
      }, [])
      // define the store update
      function storeUpdateFn (_docs) {
        _docs.forEach(_doc => {
          commit('INSERT_DOC', _doc)
        })
        return dispatch('insertDoc', _docs)
      }
      // check for hooks
      if (state._conf.sync.insertBatchHook) {
        state._conf.sync.insertBatchHook(storeUpdateFn, newDocs, store)
        return newDocs.map(_doc => _doc.id)
      }
      storeUpdateFn(newDocs)
      return newDocs.map(_doc => _doc.id)
    },
    patch ({state, getters, commit, dispatch}, doc) {
      const store = this
      // check payload
      if (!doc) return
      const id = (getters.collectionMode) ? getId(doc) : getters.docModeId
      const value = (getters.collectionMode) ? getValueFromPayloadPiece(doc) : doc
      if (!id && getters.collectionMode) return
      // check userId
      dispatch('setUserId')
      // add id to value
      if (!value.id) value.id = id
      // define the store update
      function storeUpdateFn (_val) {
        commit('PATCH_DOC', _val)
        return dispatch('patchDoc', {id, doc: copy(_val)})
      }
      // check for hooks
      if (state._conf.sync.patchHook) {
        state._conf.sync.patchHook(storeUpdateFn, value, store)
        return id
      }
      storeUpdateFn(value)
      return id
    },
    patchBatch (
      {state, getters, commit, dispatch},
      {doc, ids = []}
    ) {
      const store = this
      // check payload
      if (!doc) return []
      if (!isArray(ids) || !ids.length) return []
      // check userId
      dispatch('setUserId')
      // define the store update
      function storeUpdateFn (_doc, _ids) {
        _ids.forEach(_id => {
          commit('PATCH_DOC', {id: _id, ..._doc})
        })
        return dispatch('patchDoc', {ids: _ids, doc: _doc})
      }
      // check for hooks
      if (state._conf.sync.patchBatchHook) {
        state._conf.sync.patchBatchHook(storeUpdateFn, doc, ids, store)
        return ids
      }
      storeUpdateFn(doc, ids)
      return ids
    },
    delete ({state, getters, commit, dispatch}, id) {
      const store = this
      // check payload
      if (!id) return
      // check userId
      dispatch('setUserId')
      function storeUpdateFn (_id) {
        // id is a path
        const pathDelete = (_id.includes('.') || !getters.collectionMode)
        if (pathDelete) {
          const path = _id
          if (!path) return error('actionsDeleteMissingPath')
          commit('DELETE_PROP', path)
          return dispatch('deleteProp', path)
        }
        if (!_id) return error('actionsDeleteMissingId')
        commit('DELETE_DOC', _id)
        return dispatch('deleteDoc', _id)
      }
      // check for hooks
      if (state._conf.sync.deleteHook) {
        state._conf.sync.deleteHook(storeUpdateFn, id, store)
        return id
      }
      storeUpdateFn(id)
      return id
    },
    deleteBatch (
      {state, getters, commit, dispatch}: {state: IPluginState, getters: any, commit: any, dispatch: any},
      ids)
    {
      const store = this
      // check payload
      if (!isArray(ids) || !ids.length) return []
      // check userId
      dispatch('setUserId')
      // define the store update
      function storeUpdateFn (_ids) {
        _ids.forEach(_id => {
          // id is a path
          const pathDelete = (_id.includes('.') || !getters.collectionMode)
          if (pathDelete) {
            const path = _id
            if (!path) return error('actionsDeleteMissingPath')
            commit('DELETE_PROP', path)
            return dispatch('deleteProp', path)
          }
          if (!_id) return error('actionsDeleteMissingId')
          commit('DELETE_DOC', _id)
          return dispatch('deleteDoc', _id)
        })
      }
      // check for hooks
      if (state._conf.sync.deleteBatchHook) {
        state._conf.sync.deleteBatchHook(storeUpdateFn, ids, store)
        return ids
      }
      storeUpdateFn(ids)
      return ids
    },
    _stopPatching ({state, commit}) {
      if (state._sync.stopPatchingTimeout) { clearTimeout(state._sync.stopPatchingTimeout) }
      state._sync.stopPatchingTimeout = setTimeout(_ => { state._sync.patching = false }, 300)
    },
    _startPatching ({state, commit}) {
      if (state._sync.stopPatchingTimeout) { clearTimeout(state._sync.stopPatchingTimeout) }
      state._sync.patching = true
    }
  }
}
