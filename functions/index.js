// @ts-check
const functions = require('firebase-functions')
const admin = require("firebase-admin")
admin.initializeApp()
const db = admin.firestore()

const GROUPS = "groups"
const USERS = "users"
const TOKENS = "tokens"
const REQUESTS = "requests"
const USERS_COLLECTION = db.collection(USERS)
const GROUPS_COLLECTION = db.collection(GROUPS)

exports.setupUserInGroup = functions.firestore.document(`${USERS}/{uid}/groups/{groupId}`)
    .onCreate(async (snapshot, context) => {
        const uid = context.params.uid
        const groupId = context.params.groupId

        const doc = await USERS_COLLECTION.doc(uid).get()
        const token = doc.get("token")
        const userData = await getUserData(uid)

        let promises = []
        if (userData) {
            promises.push(GROUPS_COLLECTION.doc(`${groupId}/${USERS}/${uid}`).set(userData, { merge: true }))
        }
        if (token) {
            promises.push(GROUPS_COLLECTION.doc(`${groupId}/${TOKENS}/${uid}`).set({ token: token }))
        }
        return Promise.all(promises)
    })

// user deleted from group
exports.onUserDeleted = functions.firestore.document(`${GROUPS}/{groupId}/${USERS}/{uid}`)
    .onDelete(async (snapshot, context) => {
        const uid = context.params.uid
        const groupId = context.params.groupId

        let promises = []
        promises.push(USERS_COLLECTION.doc(`${uid}/${GROUPS}/${groupId}`).delete())
        return Promise.all(promises)
    })

// watch for changing token
exports.changeTokenInGroups = functions.firestore.document(`${USERS}/{uid}`)
    .onWrite(async (change, context) => {
        const document = change.after.exists ? change.after.data() : null;
        const oldDocument = change.before.exists ? change.before.data() : null;
        if (document && oldDocument && oldDocument.token === document.token) { return 0 }

        let token = null
        if (document) { token = document.token }

        const uid = context.params.uid
        const promises = []
        const groups = await USERS_COLLECTION.doc(uid).collection(GROUPS).get()
        groups.forEach(groupUsr => {
            const groupId = groupUsr.id
            const ref = GROUPS_COLLECTION.doc(`${groupId}/${TOKENS}/${uid}`)
            if (token) {
                const isPause = groupUsr.get("pause")
                if (!isPause) {
                    promises.push(ref.set({ token: token }))
                    console.log("set token in group " + groupId + '  uid: ' + uid)
                }
            } else {
                promises.push(ref.delete())
                console.log("delete token in group " + groupId + '  uid: ' + uid)
            }
        })
        return Promise.all(promises)
    })

exports.changeGroupName = functions.firestore.document(`${GROUPS}/{groupId}`)
    .onUpdate(async (change, context) => {
        const document = change.after.exists ? change.after.data() : null;
        const oldDocument = change.before.exists ? change.before.data() : null;
        if (document.name === oldDocument.name) { return 0 }
        const groupId = context.params.groupId

        const users = await GROUPS_COLLECTION.doc(groupId).collection(USERS).get();
        const promises = []
        users.forEach(user => {
            const uid = user.id;
            const ref = USERS_COLLECTION.doc(`${uid}/${GROUPS}/${groupId}`)
            promises.push(ref.set({ name: document.name }, { merge: true }))
        })
        return Promise.all(promises)
    })

exports.sendNotfications = functions.firestore.document(`${REQUESTS}/{groupId}`)
    .onWrite(async (change, context) => {
        const document = change.after.exists ? change.after.data() : null;
        if (document === null) return
        const groupId = context.params.groupId
        let uidReq = document.uid
        let tokenDocs = await GROUPS_COLLECTION.doc(groupId).collection(TOKENS).get()
        console.log('send notif to '+ tokenDocs.size + ' users from group: ' + groupId )
        if (tokenDocs.size === 0) {
            console.log('There are no notification tokens to send to.')
            return
        }
        let requestTime = document.time.toMillis().toString()
        let mapUidToken = []
        let promises = []

        for (let i = 0; i < tokenDocs.size; i++) {
            const doc = tokenDocs.docs[i]
            const toUid = doc.id
            if (toUid === uidReq) continue
            const token = doc.data().token

            mapUidToken.push([toUid, token])
            const payload = {
                data: {
                    group: groupId,
                    reqPos: requestTime,
                    uid: toUid
                }
            }
            const response = admin.messaging().sendToDevice(token, payload, { priority: "high" })
            // console.log("send notif to uid: " + toUid) // + "\n token: " + token)
            promises.push(response)
        }
        const responses = await Promise.all(promises)
        await cleanupTokens(responses, mapUidToken, groupId)
        return
    })

function cleanupTokens(responses, mapUidToken, groupId) {
    const tokensToRemove = [];
    // console.log("mapUidToken: " + JSON.stringify(mapUidToken))
    responses.forEach((response, index) => {

        const error = response.results[0].error
        if (error) {
            console.error('Failure sending notification to token... uid: ', `${mapUidToken[index][0]}`, error)
            if (error.code === 'messaging/invalid-registration-token' ||
                error.code === 'messaging/registration-token-not-registered') {
                const uid = mapUidToken[index][0]
                const promise = admin.firestore().doc(`${GROUPS}/${groupId}/${TOKENS}/${uid}`).delete()
                const promise2 = admin.firestore().doc(`${USERS}/${uid}`).delete()
                // .update({ token: admin.firestore.FieldValue.delete() })
                tokensToRemove.push(promise)
                tokensToRemove.push(promise2)
            }
        }
    })
    return Promise.all(tokensToRemove)
}

async function getUserData(uid) {
    const user = await admin.auth().getUser(uid)
    const name = user.displayName || user.email

    const userData = { name: name }
    if (user.photoURL) {
        userData.img = user.photoURL
    }

    return userData
}

exports.testFunc = functions.https.onRequest(async (request, result) => {
        let promises = []
    const tokens = [
        'fyeiKUiT3sg:APA91bFlvVhO92JZi_HoFeWJZddCymAr9sENMm4CpZ-1-Lc1TxpcEa62rmO6uhtkQ4_5xwUljowmtyC1qXrNlHGozfwp7P2GIY3ZU2Jcd0ysZhPojpVPAd2tl5KxWeQ_lxhKaP1OFh4Y' // miha
    ]
    tokens.forEach(token => {
        const payload = {
            data: {
                msg: "hello world"
            }
        }
        const response = admin.messaging().sendToDevice(token, payload, { priority: "high" })
        // console.log("send notif to uid: " + toUid) // + "\n token: " + token)
        promises.push(response)
    })
    try {
        const results = await Promise.all(promises)
        return result.status(200).send("success")
    } catch (error) {
        return result.status(403).send(error)
    }
})

// exports.deleteAllDB = functions.https.onRequest(async (request, result) => {
//     let promises = []
//     let snapUsers = await db.collection(USERS).listDocuments()
//     snapUsers.forEach(async (doc) => {
//         promises.push(deleteCollection(`${USERS}/${doc.id}/${GROUPS}`))
//         promises.push(deleteCollection(`${USERS}/${doc.id}/${TOKENS}`))
//     })
//     let snapGroups = await db.collection(`${GROUPS}`).listDocuments()
//     snapGroups.forEach(async (doc) => {
//         promises.push(deleteCollection(`${GROUPS}/${doc.id}/${USERS}`))
//         promises.push(deleteCollection(`${GROUPS}/${doc.id}/${TOKENS}`))
//         promises.push(deleteCollection(`${GROUPS}/${doc.id}/banned`))
//     })
//     promises.push(deleteCollection(`${REQUESTS}`))
//     promises.push(deleteCollection(`${GROUPS}`))
//     promises.push(deleteCollection(`${USERS}`))
//     promises.push(deleteCollection(`group_share_keys`))

//     try {
//         const results = await Promise.all(promises)
//         return result.status(200).send("success deleting groups and users")
//     } catch (error) {
//         return result.status(403).send(error)
//     }
// })

// function deleteCollection(collectionPath) {
//     console.log(`deleteCollection() path: ${collectionPath} `)
//     const batchSize = 10
//     let query = db.collection(collectionPath).orderBy('__name__').limit(batchSize);
//     return new Promise((resolve, reject) => {
//         deleteQueryBatch(query, batchSize, resolve, reject);
//     })
// }

// function deleteQueryBatch(query, batchSize, resolve, reject) {
//     query.get()
//         .then((snapshot) => {
//             // When there are no documents left, we are done
//             if (snapshot.size === 0) {
//                 return 0;
//             }

//             // Delete documents in a batch
//             let batch = db.batch();
//             snapshot.docs.forEach((doc) => {
//                 // if (doc.id === DEFAULT_GROUP) { return }
//                 batch.delete(doc.ref);
//             });

//             return batch.commit().then(() => {
//                 return snapshot.size;
//             });
//         }).then((numDeleted) => {
//             if (numDeleted === 0) {
//                 resolve();
//                 return;
//             }

//             // Recurse on the next process tick, to avoid
//             // exploding the stack.
//             process.nextTick(() => {
//                 deleteQueryBatch(query, batchSize, resolve, reject);
//             });
//             resolve();
//             return
//         })
//         .catch(reject);
// }


