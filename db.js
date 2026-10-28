// Storage in the browser (IndexedDB), so notes survive closing Chrome and work offline.
//   lessons: one object per lesson (title, pages of strokes, timeline)
//   audio:   the recording, saved in chunks of a few seconds as it is made, keyed "<lesson>:<take>:<chunk>"
const DB_NAME = "lesson-notes";
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("lessons", { keyPath: "id" });
      db.createObjectStore("audio", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

// Runs one request in a transaction and resolves with its result once the transaction has completed
async function run(store, mode, makeRequest) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = makeRequest(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const pad = (n) => String(n).padStart(6, "0");
const audioRange = (prefix) => IDBKeyRange.bound(prefix, prefix + "￿");

export const getLessons = () => run("lessons", "readonly", (s) => s.getAll());
export const getLesson = (id) => run("lessons", "readonly", (s) => s.get(id));
export const putLesson = (lesson) => run("lessons", "readwrite", (s) => s.put(lesson));

export async function deleteLesson(id) {
  await run("audio", "readwrite", (s) => s.delete(audioRange(id + ":")));
  await run("lessons", "readwrite", (s) => s.delete(id));
}

export const putAudioChunk = (lessonId, take, chunk, blob) =>
  run("audio", "readwrite", (s) => s.put({ key: `${lessonId}:${pad(take)}:${pad(chunk)}`, blob }));

// The chunks of one take, in order
export const getAudioChunks = async (lessonId, take) =>
  (await run("audio", "readonly", (s) => s.getAll(audioRange(`${lessonId}:${pad(take)}:`)))).map((r) => r.blob);

// How many chunks one take has (without loading them)
export const countAudioChunks = (lessonId, take) => run("audio", "readonly", (s) => s.count(audioRange(`${lessonId}:${pad(take)}:`)));
