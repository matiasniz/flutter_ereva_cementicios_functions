const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

function loadUsers(idEmpresa) {
  return admin
    .firestore()
    .collection("usuarios")
    .where("empresa", "==", idEmpresa)
    .get()
    .then((snap) => snap.docs);
}

const sendNotification = async (idEmpresa, documento) => {
  return loadUsers(idEmpresa).then((users) => {
    let tokens = [];
    for (let user of users) {
      let datos = user.data();
      if (datos.fcm && datos.rol === "admin") {
        tokens.push(datos.fcm);
      }
    }

    let payload = {
      data: {
        sound: "default",
        id: "1",
        status: "done",
        action: "chatMessage",
        body: `${documento.nombre} se encuentra por debajo del stock minimo`,
        title: `Alerta de stock - insumo: ${documento.nombre}`,
      },
    };

    var options = {
      priority: "high",
      contentAvailable: true,
    };

    return admin.messaging().sendToDevice(tokens, payload, options);
  });
};

const registrarStockProductos = async (
  producto,
  stockRef,
  cantidad,
  idColor
) => {
  let productoStock = await stockRef.get();
  if (!productoStock || !productoStock.data()) {
    return stockRef.set({
      demanda: 0,
      stock: (newStock = producto.data().revestimiento
        ? (producto.data().porMolde * cantidad) / producto.data().rinde
        : cantidad),
      producto: producto.id,
      color: idColor,
    });
  } else {
    return (transaction = db
      .runTransaction((t) => {
        return t.get(stockRef).then((doc) => {
          let newStock = 0;
          if (doc && doc.data()) {
            newStock = producto.data().revestimiento
              ? (doc.data().stock ? doc.data().stock : 0) +
                (producto.data().porMolde * cantidad) / producto.data().rinde
              : cantidad;
          } else {
            newStock = producto.data().revestimiento
              ? (producto.data().porMolde * cantidad) / producto.data().rinde
              : cantidad;
          }

          t.update(stockRef, { stock: newStock });
        });
      })
      .then((result) => {
        console.log("Transaction success", result);
      })
      .catch((err) => {
        console.log("Transaction failure:", err);
      }));
  }
};

const restarMateriaPrimaTransaction = (empresaId, idMaterial, cantidad) => {
  let materialRef = db
    .collection("empresas")
    .doc(empresaId)
    .collection("materia_prima")
    .doc(idMaterial);

  return db
    .runTransaction((t) => {
      return t.get(materialRef).then(async (doc) => {
        let newStock = doc.data().stock - cantidad;

        if (
          doc.data().controlaStock &&
          doc.data().minimo &&
          newStock < doc.data().minimo
        ) {
          await sendNotification(empresaId, doc.data());
        }
        t.update(materialRef, { stock: newStock });
      });
    })
    .then((result) => {
      console.log("Transaction success", result);
    })
    .catch((err) => {
      console.log("Transaction failure:", err);
    });
};

exports.autovalidar = functions.https.onRequest(async (req, res) => {
  let fecha = admin.firestore.Timestamp.fromDate(
    new Date(new Date().getTime() - 48 * 60 * 60 * 1000)
  );

  let empresasCollection = await db.collection("empresas").listDocuments();

  return Promise.all(
    empresasCollection.map((emp) => {
      return db
        .collection("empresas")
        .doc(emp.id)
        .collection("produccion")
        .where("validado", "==", false)
        .where("fecha", "<", fecha)
        .get()
        .then((datos) => {
          return Promise.all(
            datos.docs.map((p) => {
              return p.ref.update({
                validado: true,
              });
            })
          ).then(() =>
            console.log(
              `se validaron ${datos.docs.length} documentos de la empresa ${emp.id}`
            )
          );
        });
    })
  )
    .then(() => {
      res.status(200).send(`fin validacion`);
    })
    .catch((err) => {
      res.status(404).send(err);
    });
});

exports.produccion = functions.firestore
  .document("/empresas/{empresaId}/produccion/{id}")
  .onUpdate(async (change, context) => {
    const empresaId = context.params.empresaId;
    const document = change.after.exists ? change.after.data() : null;
    const oldDocument = change.before.data();

    if (!oldDocument.validado && document.validado) {
      let materiaPrimaResponse = await db
        .collection("empresas")
        .doc(empresaId)
        .collection("materia_prima")
        .get();

      let listaMateriaPrima = materiaPrimaResponse.docs.map((d) => {
        return {
          id: d.id,
          ...d.data(),
        };
      });

      let insumos = [];
      let ferrites = [];
      if (document.idMezcla !== "personalizado") {
        let mezcla = await db
          .collection("empresas")
          .doc(empresaId)
          .collection("mezclas")
          .doc(document.idMezcla)
          .get();
        if (mezcla) {
          insumos = mezcla.data().insumos;
        }
      } else {
        insumos = document.insumos;
      }

      if (
        document.idColor !== null &&
        document.idColor !== "personalizado" &&
        document.idColor.length > 0
      ) {
        let color = await db
          .collection("empresas")
          .doc(empresaId)
          .collection("colores")
          .doc(document.idColor)
          .get();
        if (color) {
          ferrites = color.data().insumos;
        }
      } else {
        ferrites = document.ferrites;
      }

      // no es revestimiento
      // moldes => cantidad
      if (document.idProducto && document.idProducto.length > 0) {
        // producto producido
        let producto = await db
          .collection("empresas")
          .doc(empresaId)
          .collection("productos")
          .doc(document.idProducto)
          .get();

        //referencia al stock del producto producido
        let docId =
          document.idProducto + (document.idColor ? document.idColor : "");
        let docRef = await db
          .collection("empresas")
          .doc(empresaId)
          .collection("stock_productos")
          .doc(docId);

        await registrarStockProductos(producto, docRef, document.moldes, "");
      }
      // sino, es revestimiento
      else {
        await Promise.all(
          document.productos.map(async (p) => {
            let producto = await db
              .collection("empresas")
              .doc(empresaId)
              .collection("productos")
              .doc(p.insumoUuid)
              .get();
            let docId =
              p.insumoUuid + (document.idColor ? document.idColor : "");
            let docRef = db
              .collection("empresas")
              .doc(empresaId)
              .collection("stock_productos")
              .doc(docId);

            return registrarStockProductos(
              producto,
              docRef,
              p.cantidad,
              document.idColor || ""
            );
          })
        );
      }

      // iterar insumos (insumoUuid) de la mezcla (cantidad) * document.multiplicador
      // iterar en una seria de transacciones para afectar stock de materia prima
      // (solo restara stock si "controla stock")
      await Promise.all(
        insumos.map((ins) => {
          let mprima = listaMateriaPrima.find((l) => l.id === ins.insumoUuid);
          if (mprima) {
            return mprima.controlaStock
              ? restarMateriaPrimaTransaction(
                  empresaId,
                  ins.insumoUuid,
                  ins.cantidad * document.multiplicadorMezcla
                )
              : true;
          } else {
            return true;
          }
        })
      );

      return await Promise.all(
        ferrites.map((ins) => {
          let mprima = listaMateriaPrima.find((l) => l.id === ins.insumoUuid);
          if (mprima) {
            return mprima.controlaStock
              ? restarMateriaPrimaTransaction(
                  empresaId,
                  ins.insumoUuid,
                  ins.cantidad * document.multiplicadorColor
                )
              : true;
          } else {
            return true;
          }
        })
      );
    } else {
      return true;
    }
  });

exports.nuevaCompra = functions.firestore
  .document("/empresas/{empresaId}/compras/{id}")
  .onCreate(async (snapshot, context) => {
    const empresaId = context.params.empresaId;
    const document = snapshot.data();

    let materialRef = db
      .collection("empresas")
      .doc(empresaId)
      .collection("materia_prima")
      .doc(document.idMaterial);

    let material = await materialRef.get();

    await db
      .collection("empresas")
      .doc(empresaId)
      .collection("mov_cajas")
      .add({
        caja: document.idCaja,
        concepto: "Compra",
        pedido: null,
        comentario:
          material.data().nombre +
          " " +
          document.cantidad +
          material.data().medida,
        fecha: new Date(),
        monto: document.monto * -1,
      });

    if (material.data().controlaStock) {
      return (transaction = db
        .runTransaction((t) => {
          return t.get(materialRef).then((doc) => {
            let newStock = doc.data().stock + document.cantidad;

            t.update(materialRef, { stock: newStock });
          });
        })
        .then((result) => {
          console.log("Transaction success", result);
        })
        .catch((err) => {
          console.log("Transaction failure:", err);
        }));
    } else {
      return "no controla stock";
    }
  });

exports.nuevoGasto = functions.firestore
  .document("/empresas/{empresaId}/gastos/{id}")
  .onCreate(async (snapshot, context) => {
    const empresaId = context.params.empresaId;
    const document = snapshot.data();

    let conceptoGato = await db
      .collection("empresas")
      .doc(empresaId)
      .collection("conceptos_gastos")
      .doc(document.idConcepto)
      .get();

    return db
      .collection("empresas")
      .doc(empresaId)
      .collection("mov_cajas")
      .add({
        caja: document.idCaja,
        concepto: "Gasto",
        pedido: null,
        comentario: conceptoGato.data().nombre,
        fecha: new Date(),
        monto: document.monto * -1,
      });
  });

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
            // if (!p.color) return;

            let productRef = db
              .collection("empresas")
              .doc(empresaId)
              .collection("stock_productos")
              .doc(
                p.producto +
                  (p.color !== null && p.color.length > 0 ? p.color : "")
              );

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

      if (oldDocument && oldDocument.estado !== 3 && document.estado === 3) {
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
            // if (!p.color) return;

            let productRef = db
              .collection("empresas")
              .doc(empresaId)
              .collection("stock_productos")
              .doc(
                p.producto +
                  (p.color !== null && p.color.length > 0 ? p.color : "")
              );

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
                color: p.color !== null && p.color.length > 0 ? p.color : "",
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

exports.newuser = functions.https.onRequest(async (req, res) => {
  let user = req.body;

  let userRecord = await admin.auth().createUser({
    email: user.email,
    emailVerified: false,
    password: "123456",
    displayName: user.nombre,
    disabled: false,
  });

  return db
    .collection("usuarios")
    .doc(userRecord.uid)
    .set(user)
    .then((datos) =>
      console.log(`se dio de alta nuevo usuario de la empresa ${user.empresa}`)
    )
    .catch((err) => {
      res.status(404).send(err);
    });
});
