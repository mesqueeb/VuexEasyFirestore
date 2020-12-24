// firebase
import firebase from 'firebase/app'
import 'firebase/firestore'
import 'firebase/auth'
import { getKeysFromPath } from 'vuex-easy-access'
import { isArray } from 'is-what'
import iniModule, { FirestoreConfig } from './module'
import { IEasyFirestoreModule } from './declarations'
import {
  arrayUnion,
  arrayRemove,
  setFirebaseDependency as setFirebase1,
} from './utils/arrayHelpers'
import { increment, setFirebaseDependency as setFirebase2 } from './utils/incrementHelper'

/**
 * Create vuex-easy-firestore modules. Add as single plugin to Vuex Store.
 *
 * @export
 * @param {(IEasyFirestoreModule | IEasyFirestoreModule[])} easyFirestoreModule A vuex-easy-firestore module (or array of modules) with proper configuration as per the documentation.
 * @param {{logging?: boolean, FirebaseDependency?: any}} extraConfig An object with `logging` and `FirebaseDependency` props. `logging` enables console logs for debugging. `FirebaseDependency` is the non-instanciated firebase class you can pass. (defaults to the firebase peer dependency)
 * @returns {*}
 */
function vuexEasyFirestore (
  easyFirestoreModule: IEasyFirestoreModule | IEasyFirestoreModule[],
  {
    logging = false,
    preventInitialDocInsertion = false,
    FirebaseDependency = firebase,
    enablePersistence = false,
    synchronizeTabs = false,
  }: {
    logging?: boolean
    preventInitialDocInsertion?: boolean
    FirebaseDependency?: any
    enablePersistence?: boolean
    synchronizeTabs?: boolean
  } = {
    logging: false,
    preventInitialDocInsertion: false,
    FirebaseDependency: firebase,
    enablePersistence: false,
    synchronizeTabs: false,
  }
): any {
  if (FirebaseDependency) {
    setFirebase1(FirebaseDependency)
    setFirebase2(FirebaseDependency)
  }
  return store => {
    // Get an array of config files
    if (!isArray(easyFirestoreModule)) easyFirestoreModule = [easyFirestoreModule]
    // Create a module for each config file
    easyFirestoreModule.forEach((config: IEasyFirestoreModule) => {
      config.logging = logging
      if (config.sync && config.sync.preventInitialDocInsertion === undefined) {
        config.sync.preventInitialDocInsertion = preventInitialDocInsertion
      }
      const moduleName = getKeysFromPath(config.moduleName)
      const firestoreConfig: FirestoreConfig = { FirebaseDependency, enablePersistence, synchronizeTabs }
      store.registerModule(moduleName, iniModule(config, firestoreConfig))
    })
  }
}

export { vuexEasyFirestore, arrayUnion, arrayRemove, increment }
export default vuexEasyFirestore
