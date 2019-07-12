// @ts-check
const functions = require('firebase-functions');
const admin = require("firebase-admin");
admin.initializeApp();
const GROUPS = "groups";
const USERS = "users";
const TOKENS = "tokens";

// 3 
exports.setupUserInGroup = functions.firestore.document(`${USERS}/{uid}/groups/{groupId}`)
    .onCreate(async (snapshot, context) => {
        const uid = context.params.uid
        const groupId = context.params.groupId
        const db = admin.firestore()

        const banned = await db.doc(`${GROUPS}/${groupId}/banned/${uid}`).get()
        if (banned) { return snapshot.ref.delete() }

        const token = (await db.doc(`${USERS}/${uid}`).get()).data().token
        const userData = await getUserData(uid)

        let batch = db.batch();
        batch.set(db.doc(`${GROUPS}/${groupId}/${USERS}/${uid}`), userData, { merge: true })
        batch.set(db.doc(`${GROUPS}/${groupId}/${TOKENS}/${uid}`), token)
        return batch.commit()
    })

// 6  watch out for changing token
exports.setTokenInGroups = functions.firestore.document(`${USERS}/{uid}`)
    .onWrite(async (change, context) => {
        const document = change.after.exists ? change.after.data() : null;
        const oldDocument = change.before.data()
        const token = document.token || null
        if (token === oldDocument.token) return 0  
        const db = admin.firestore()
        const uid = context.params.uid
        const promises = []
        const groups = await db.collection(`${USERS}/${uid}/${GROUPS}`).get()
        groups.forEach(doc => {
            const groupId = doc.id
            const ref = db.doc(`${GROUPS}/${groupId}/${TOKENS}/${uid}`)
            promises.push(ref.set(token), { merge: true }) // "pause" may be present
        })
        return Promise.all(promises)
    })

// 8
exports.changeGroupNameInUsers = functions.firestore.document(`${GROUPS}/{groupId}`)
    .onUpdate(async (change, context) => {
        const document = change.after.exists ? change.after.data() : null;
        const oldDocument = change.before.exists ? change.before.data() : null;
        if (document.groupName === oldDocument.groupName) { return 0 }
        const groupId = context.params.groupId
        const db = admin.firestore()
        const users = await db.collection(`${GROUPS}/${groupId}/${USERS}`).get();
        const promises = []
        users.forEach(user => {
            const uid = user.id;
            const ref = db.doc(`${USERS}/${uid}/${GROUPS}/${groupId}`)
            promises.push(ref.set({ groupName: document.groupName }, { merge: true }))
        })
        return Promise.all(promises)
    })

// 5              
exports.sendNotfications = functions.firestore.document(`requests/{groupId}`)
.onUpdate(async (change, context) => {
    const document = change.after.data()
    const groupId = context.params.groupId
    const payload = {
        data: {
            groupId: groupId,
            request: "updatePosition",
            name: document.name
        }
    }
    let tokensToNotify = []
    let uidsToNotify = []
    const docs = await admin.firestore().collection(`${GROUPS}/${groupId}/${TOKENS}`).get()
    docs.forEach(doc => {
        const token = doc.data().token
        const paused = doc.data().pause
        const uid = doc.id
        if (token && !paused) {
            tokensToNotify.push(token)
            uidsToNotify.push(uid)
        }
    })
    if (tokensToNotify.length > 0) {
        const response = await admin.messaging().sendToDevice(tokensToNotify, payload, { priority: "high" })
        return cleanupTokens(response, tokensToNotify, uidsToNotify)
    }
    return 0
})

async function getUserData(uid) {
    // console.log("getUserData(uid) ")
    const user = await admin.auth().getUser(uid)
    const name = user.displayName || user.email
    const photoUrl = user.photoURL || ""
    const userData = { name: name, photoUrl: photoUrl }
    return userData
}

function cleanupTokens(response, tokens, uids) {         
    console.log("cleanup invalid tokens")
    const tokensDelete = [];
    response.results.forEach((result, index) => {
        const error = result.error;
        if (error) {
            const token = tokens[index];
            const uid = uids[index]
            console.error('Failure sending notification to token ', `${token}`, error);
            if (error.code === 'messaging/invalid-registration-token' ||
                error.code === 'messaging/registration-token-not-registered') {
                const deleteTask = admin.firestore().doc(`${USERS}/${uid}`)
                    .update({ token: admin.firestore.FieldValue.delete() })
                tokensDelete.push(deleteTask);
            }
        }
    });
    return Promise.all(tokensDelete);
}

exports.deleteDB = functions.https.onCall(async (data, context) => {
    // const uid = context.auth.uid;
    // const text = data.text;
    const collectionRefUsers = admin.firestore().collection(USERS)
    let snapUsers = await collectionRefUsers.listDocuments()
    snapUsers.forEach(async (doc) => {
        await deleteCollection(`${USERS}/${doc.id}/${GROUPS}`)
        await deleteCollection(`${USERS}/${doc.id}/${TOKENS}`)
    })
    await deleteCollection(`${USERS}`)

    const collectionRef = admin.firestore().collection(`groups`)
    let snap = await collectionRef.listDocuments()
    snap.forEach(async (doc) => {
        if (doc.id !== "defaultGroup") {
            await deleteCollection(`${GROUPS}/${doc.id}/${USERS}`)

            await deleteCollection(`${GROUPS}/${doc.id}/${TOKENS}`)
            await deleteCollection(`${GROUPS}/${doc.id}/banned`)
        }
    });
    await deleteCollection(`${GROUPS}`)
    await deleteCollection(`requests`)
});

function deleteCollection(collectionPath) {
    console.log(`deleteCollection() path: ${collectionPath} `)
    const db = admin.firestore();
    const batchSize = 10
    let collectionRef = db.collection(collectionPath);
    let query = collectionRef.orderBy('__name__').limit(batchSize);
    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, batchSize, resolve, reject);
    });
}

function deleteQueryBatch(db, query, batchSize, resolve, reject) {
    query.get()
        .then(async (snapshot) => {
            // When there are no documents left, we are done
            if (snapshot.size === 0) {
                return 0;
            }

            // Delete documents in a batch
            let batch = db.batch();
            snapshot.docs.forEach((doc) => {
                if (doc.id !== "defaultGroup") {
                    batch.delete(doc.ref);
                }

            });

            const snap = await batch.commit()
            return snap.size;

        }).then((numDeleted) => {
            if (numDeleted === 0) {
                resolve();
                return 0;
            }

            // Recurse on the next process tick, to avoid exploding the stack
            process.nextTick(() => {
                deleteQueryBatch(db, query, batchSize, resolve, reject);
            });
            return 0;
        })
        .catch(reject);
}



/* 
exports.modifyToken = functions.firestore.document(`fcmTokens/{token}`).onWrite(async (change, context) => {
    console.log("modifyToken() onWrite")
    const document = change.after.exists ? change.after.data() : null;
    const oldDocument = change.before.exists ? change.before.data() : null;
    const token = context.params.token

    if (!document) { // deleted
        return deleteTokenInGroups(oldDocument.uid, token)
    } else if (!oldDocument) { // created
        return setTokenInGroups(document.uid, token)
    } else if (document.uid !== oldDocument.uid) {  // user replaced 
        await deleteTokenInGroups(oldDocument.uid, token)
        await setTokenInGroups(document.uid, token)
    }
    return 0;
})
 */