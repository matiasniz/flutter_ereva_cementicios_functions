const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
exports.movCaja = functions.firestore
  .document("/empresas/{empresaId}/mov_cajas/{id}")
  .onCreate((snapshot, context) => {
    const empresaId = context.params.empresaId;
    const document = snapshot.data();

    let cajaRef = db
      .collection("empresas")
      .doc(empresaId)
      .collection("cajas")
      .doc(document.caja);

    return (transaction = db
      .runTransaction((t) => {
        return t.get(cajaRef).then((doc) => {
          let newSaldo = doc.data().saldo + document.monto;

          t.update(cajaRef, { saldo: newSaldo });
        });
      })
      .then((result) => {
        console.log("Transaction success", result);
      })
      .catch((err) => {
        console.log("Transaction failure:", err);
      }));
  });
