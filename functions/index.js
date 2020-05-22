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

exports.pedidos = functions.firestore
  .document("/empresas/{empresaId}/pedidos/{id}")
  .onWrite(async (change, context) => {
    const empresaId = context.params.empresaId;
    const pedidoId = context.params.id;
    // Get an object with the current document value.
    // If the document does not exist, it has been deleted.
    const document = change.after.exists ? change.after.data() : null;

    // Get an object with the previous document value (for update or delete)
    const oldDocument = change.before.data();

    const pedidoRef = db
      .collection("empresas")
      .doc(empresaId)
      .collection("pedidos")
      .doc(pedidoId);

    let FieldValue = require("firebase-admin").firestore.FieldValue;

    if (!change.before.exists) {
      // new document created : add one to count
      pedidoRef.update({ numero: FieldValue.increment(1) });
      console.log("%s numberOfDocs incremented by 1", pedidoId);
    }

    if (document.numero > 0 && oldDocument && oldDocument.numero === 0)
      return null;

    if (oldDocument && oldDocument.saldo !== document.saldo) return null;

    if (document) {
      if (oldDocument) {
        console.log("se esta queriendo actualizar un pedido");
        await Promise.all(
          oldDocument.productos.map((p) => {
            if (!p.color) return;

            let productRef = db
              .collection("empresas")
              .doc(empresaId)
              .collection("stock_productos")
              .doc(p.producto + p.color);

            return (transaction = db
              .runTransaction((t) => {
                return t.get(productRef).then((doc) => {
                  let newSaldo = 0;
                  if (doc && doc.data()) {
                    newSaldo =
                      (doc.data().demanda ? doc.data().demanda : 0) -
                      p.cantidad;
                  } else {
                    newSaldo = p.cantidad;
                  }
                  t.update(productRef, { demanda: newSaldo });
                });
              })
              .then((result) => {
                console.log("Transaction success", result);
              })
              .catch((err) => {
                console.log("Transaction failure:", err);
              }));
          })
        );
      } else {
        console.log("se creo un nuevo pedido");
      }

      let saldo = 0;
      document.productos.map(async (p) => {
        saldo += p.precio;
      });
      saldo += document.flete;

      let pagos = await db
        .collection("empresas")
        .doc(empresaId)
        .collection("pagos")
        .where("pedido", "==", pedidoId)
        .get();

      pagos.docs.map((p) => {
        let doc = p.data();
        saldo -= doc.monto;
      });

      console.log("registando saldo: " + saldo);
      if (document.saldo !== saldo) {
        pedidoRef.update({ saldo });
      }

      return Promise.all(
        document.productos.map(async (p) => {
          if (!p.color) return;

          let productRef = db
            .collection("empresas")
            .doc(empresaId)
            .collection("stock_productos")
            .doc(p.producto + p.color);

          let prod = await productRef.get();
          if (prod && prod.data()) {
            return (transaction = db
              .runTransaction((t) => {
                return t.get(productRef).then((doc) => {
                  console.log("el articulo existe, actualizando demanda...");
                  let newSaldo =
                    (doc.data().demanda ? doc.data().demanda : 0) + p.cantidad;
                  t.update(productRef, { demanda: newSaldo });
                });
              })
              .then((result) => {
                console.log("Transaction success", result);
              })
              .catch((err) => {
                console.log("Transaction failure:", err);
              }));
          } else {
            return productRef.set({
              demanda: p.cantidad,
              producto: p.producto,
              color: p.color,
              stock: 0,
            });
          }
        })
      );
    }
  });
