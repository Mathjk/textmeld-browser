const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('textmeld-browser-files-v1', 1)
  request.onupgradeneeded = () => {
    for (const name of ['drafts', 'fonts']) request.result.createObjectStore(name)
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

type Store = 'drafts' | 'fonts'

export async function read<T>(name: Store, key: string): Promise<T | undefined> {
  const db = await database
  return new Promise((resolve, reject) => {
    const request = db.transaction(name).objectStore(name).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function list<T>(name: Store): Promise<T[]> {
  const db = await database
  return new Promise((resolve, reject) => {
    const request = db.transaction(name).objectStore(name).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function change<T>(name: Store, key: string, update: (current?: T) => T | undefined) {
  const db = await database
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(name, 'readwrite')
    const store = transaction.objectStore(name)
    const query = store.get(key)
    let failure: unknown
    query.onsuccess = () => {
      try {
        const next = update(query.result)
        if (next === undefined) store.delete(key)
        else store.put(next, key)
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('浏览器储存写入失败。'))
    transaction.onerror = () => reject(transaction.error)
  })
}
