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

exports.pago = functions.firestore
  .document("/empresas/{empresaId}/pagos/{id}")
  .onCreate(async (snapshot, context) => {
    const empresaId = context.params.empresaId;
    const document = snapshot.data();

    let pedidoRef = db
      .collection("empresas")
      .doc(empresaId)
      .collection("pedidos")
      .doc(document.pedido);

    await db.collection("empresas").doc(empresaId).collection("mov_cajas").add({
      caja: document.caja,
      concepto: "Pago de pedido",
      pedido: document.pedido,
      comentario: "Ingreso por pago de pedido",
      monto: document.monto,
      fecha: new Date(),
    });

    return (transaction = db
      .runTransaction((t) => {
        return t.get(pedidoRef).then((doc) => {
          let newSaldo = doc.data().saldo - document.monto;

          t.update(pedidoRef, { saldo: newSaldo });
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

    if (!change.before.exists) {
      let pedidos = await db
        .collection("empresas")
        .doc(empresaId)
        .collection("pedidos")
        .get();

      pedidoRef.update({ numero: pedidos.docs.length });
    }

    if (document.numero > 0 && oldDocument && oldDocument.numero === 0)
      return null;

    if (oldDocument && oldDocument.saldo !== document.saldo) return null;

    if (document) {
      if (oldDocument && oldDocument.estado !== 2) {
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

      if (oldDocument && oldDocument.estado === 0 && document.estado === 3) {
        let pagos = await db
          .collection("empresas")
          .doc(empresaId)
          .collection("pagos")
          .where("pedido", "==", pedidoId)
          .get();
        return Promise.all(
          pagos.docs.map((p) => {
            let dataPago = p.data();
            let mov = {
              fecha: new Date(),
              caja: dataPago.caja,
              monto: dataPago.monto * -1,
              pedido: pedidoId,
              concepto: "Pedido anulado",
              comentario: "Por anulacion de pedido",
            };
            return db
              .collection("empresas")
              .doc(empresaId)
              .collection("mov_cajas")
              .add(mov);
          })
        );
      }

      if (document.estado == 3) {
        console.log("aqui no debio haber entrado..");
      }
      /**
       * re calculando total para registrar transaccion por diferencia
       */
      let saldo = 0;
      document.productos.map(async (p) => {
        saldo += p.precio;
      });
      saldo += document.flete;

      let saldoAnterior = 0;

      if (change.before.exists) {
        oldDocument.productos.map(async (p) => {
          saldoAnterior += p.precio;
        });
        saldoAnterior += oldDocument.flete;
      }

      let nuevoSaldo = saldo - saldoAnterior;

      //realizando transaccion

      db.runTransaction((t) => {
        return t.get(pedidoRef).then((doc) => {
          let newSaldo = doc.data().saldo + Number(nuevoSaldo);

          t.update(pedidoRef, { saldo: newSaldo });
        });
      });

      // fin transaccion

      // alta, reparto, entregado, suspendido, deudor

      if (document.estado !== 3) {
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
                    let newSaldo = 0;

                    if (document.estado !== 2) {
                      //actualiza demanda, volviendo a sumar la cantidad pedida

                      let newSaldo =
                        (doc.data().demanda ? doc.data().demanda : 0) +
                        p.cantidad;

                      t.update(productRef, { demanda: newSaldo });
                    } else {
                      if (oldDocument.estado !== 2) {
                        // actualiza stock, restando lo entregado, siempre y cuando el estado anterior no sea entregado (evita restar stock dos veces)
                        newSaldo =
                          (doc.data().stock ? doc.data().stock : 0) -
                          p.cantidad;
                        t.update(productRef, { stock: newSaldo });
                      }
                    }
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
      } else {
        return true;
      }
    }
  });
