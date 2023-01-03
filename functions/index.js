/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

exports.autovalidacion = functions.pubsub
    .schedule("0 0 * * *")
    .onRun(async (_) => {
      console.log("inicio autovalidacion");
      const fecha = admin.firestore.Timestamp.fromDate(
          new Date(new Date().getTime() - 48 * 60 * 60 * 1000),
      );

      const empresasCollection = await db.collection("empresas").listDocuments();

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
                      }),
                  ).then(() =>
                    console.log(
                        `se validaron ${datos.docs.length} documentos de la empresa ${emp.id}`,
                    ),
                  );
                });
          }),
      )
          .then(() => {
            return null;
          })
          .catch((err) => {
            return null;
          });
    });

async function loadUsers(idEmpresa) {
  const snap = await admin
      .firestore()
      .collection("usuarios")
      .where("empresa", "==", idEmpresa)
      .get();
  return snap.docs;
}

const sendNotification = async (idEmpresa, documento) => {
  return loadUsers(idEmpresa).then((users) => {
    const tokens = [];
    for (const user of users) {
      const datos = user.data();
      if (datos.fcm && datos.rol === "admin") {
        tokens.push(datos.fcm);
      }
    }

    const payload = {
      data: {
        sound: "default",
        id: "1",
        status: "done",
        action: "chatMessage",
        body: `${documento.nombre} se encuentra por debajo del stock minimo`,
        title: `Alerta de stock - insumo: ${documento.nombre}`,
      },
    };

    const options = {
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
    idColor,
) => {
  const productoStock = await stockRef.get();
  if (!productoStock || !productoStock.data()) {
    return stockRef.set({
      demanda: 0,
      stock: (producto.data().revestimiento ?
        ((producto.data().porMolde * cantidad) / producto.data().rinde) *
          (1 - producto.data().merma / 100) :
        cantidad),
      producto: producto.id,
      color: idColor,
    });
  } else {
    return (db
        .runTransaction((t) => {
          return t.get(stockRef).then((doc) => {
            let newStock = 0;
            if (doc && doc.data()) {
              newStock = producto.data().revestimiento ?
              (doc.data().stock ? doc.data().stock : 0) +
                ((producto.data().porMolde * cantidad) /
                  producto.data().rinde) *
                  (1 - producto.data().merma / 100) :
              cantidad;
            } else {
              newStock = producto.data().revestimiento ?
              ((producto.data().porMolde * cantidad) /
                  producto.data().rinde) *
                (1 - producto.data().merma / 100) :
              cantidad;
            }

            t.update(stockRef, {stock: newStock});
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
  const materialRef = db
      .collection("empresas")
      .doc(empresaId)
      .collection("materia_prima")
      .doc(idMaterial);

  return db
      .runTransaction((t) => {
        return t.get(materialRef).then(async (doc) => {
          const newStock = doc.data().stock - cantidad;

          if (
            doc.data().controlaStock &&
          doc.data().minimo &&
          newStock < doc.data().minimo
          ) {
            await sendNotification(empresaId, doc.data());
          }
          t.update(materialRef, {stock: newStock});
        });
      })
      .then((result) => {
        console.log("Transaction success", result);
      })
      .catch((err) => {
        console.log("Transaction failure:", err);
      });
};

exports.produccion = functions.firestore
    .document("/empresas/{empresaId}/produccion/{id}")
    .onUpdate(async (change, context) => {
      console.log("inicio produccion");
      const empresaId = context.params.empresaId;
      const document = change.after.exists ? change.after.data() : null;
      const oldDocument = change.before.data();

      if (!oldDocument.validado && document.validado) {
        const materiaPrimaResponse = await db
            .collection("empresas")
            .doc(empresaId)
            .collection("materia_prima")
            .get();

        const listaMateriaPrima = materiaPrimaResponse.docs.map((d) => {
          return {
            id: d.id,
            ...d.data(),
          };
        });

        let insumos = [];
        let ferrites = [];
        if (document.idMezcla !== "personalizado") {
          const mezcla = await db
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
          const color = await db
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
          const producto = await db
              .collection("empresas")
              .doc(empresaId)
              .collection("productos")
              .doc(document.idProducto)
              .get();

          // referencia al stock del producto producido
          const docId =
          document.idProducto + (document.idColor ? document.idColor : "");
          const docRef = await db
              .collection("empresas")
              .doc(empresaId)
              .collection("stock_productos")
              .doc(docId);

          await registrarStockProductos(producto, docRef, document.moldes, "");
        } else {
          await Promise.all(
              document.productos.map(async (p) => {
                const producto = await db
                    .collection("empresas")
                    .doc(empresaId)
                    .collection("productos")
                    .doc(p.insumoUuid)
                    .get();
                const docId =
              p.insumoUuid + (document.idColor ? document.idColor : "");
                const docRef = db
                    .collection("empresas")
                    .doc(empresaId)
                    .collection("stock_productos")
                    .doc(docId);

                return registrarStockProductos(
                    producto,
                    docRef,
                    p.cantidad,
                    document.idColor || "",
                );
              }),
          );
        }

        // iterar insumos (insumoUuid) de la mezcla (cantidad) * document.multiplicador
        // iterar en una seria de transacciones para afectar stock de materia prima
        // (solo restara stock si "controla stock")
        await Promise.all(
            insumos.map((ins) => {
              const mprima = listaMateriaPrima.find((l) => l.id === ins.insumoUuid);
              if (mprima) {
                return mprima.controlaStock ?
              restarMateriaPrimaTransaction(
                  empresaId,
                  ins.insumoUuid,
                  ins.cantidad * document.multiplicadorMezcla,
              ) :
              true;
              } else {
                return true;
              }
            }),
        );

        return await Promise.all(
            ferrites.map((ins) => {
              const mprima = listaMateriaPrima.find((l) => l.id === ins.insumoUuid);
              if (mprima) {
                return mprima.controlaStock ?
              restarMateriaPrimaTransaction(
                  empresaId,
                  ins.insumoUuid,
                  ins.cantidad * document.multiplicadorColor,
              ) :
              true;
              } else {
                return true;
              }
            }),
        );
      } else {
        return true;
      }
    });

exports.nuevaCompra = functions.firestore
    .document("/empresas/{empresaId}/compras/{id}")
    .onCreate(async (snapshot, context) => {
      console.log("inicio nuevaCompra");
      const empresaId = context.params.empresaId;
      const document = snapshot.data();

      const materialRef = db
          .collection("empresas")
          .doc(empresaId)
          .collection("materia_prima")
          .doc(document.idMaterial);

      const material = await materialRef.get();

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
        return (db
            .runTransaction((t) => {
              return t.get(materialRef).then((doc) => {
                const newStock = doc.data().stock + document.cantidad;

                t.update(materialRef, {stock: newStock});
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
      console.log("inicio nuevoGasto");
      const empresaId = context.params.empresaId;
      const document = snapshot.data();

      const conceptoGato = await db
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
      console.log("inicio movCaja");
      const empresaId = context.params.empresaId;
      const document = snapshot.data();

      const cajaRef = db
          .collection("empresas")
          .doc(empresaId)
          .collection("cajas")
          .doc(document.caja);

      return (db
          .runTransaction((t) => {
            return t.get(cajaRef).then((doc) => {
              const newSaldo = doc.data().saldo + document.monto;

              t.update(cajaRef, {saldo: newSaldo});
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
      console.log("inicio pago");
      const empresaId = context.params.empresaId;
      const document = snapshot.data();

      const pedidoRef = db
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

      return (db
          .runTransaction((t) => {
            return t.get(pedidoRef).then((doc) => {
              const newSaldo = doc.data().saldo - document.monto;

              t.update(pedidoRef, {saldo: newSaldo});
            });
          })
          .then((result) => {
            console.log("Transaction success", result);
          })
          .catch((err) => {
            console.log("Transaction failure:", err);
          }));
    });

// alta, reparto, entregado, suspendido, deudor

exports.pedidos = functions.firestore
    .document("/empresas/{empresaId}/pedidos/{id}")
    .onWrite(async (change, context) => {
      console.log("inicio pedidos");
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
        const pedidos = await db
            .collection("empresas")
            .doc(empresaId)
            .collection("pedidos")
            .get();

        pedidoRef.update({numero: pedidos.docs.length});
      }

      // if (document.numero > 0 && oldDocument && oldDocument.numero === 0)
      //   return null;

      if (oldDocument && oldDocument.saldo !== document.saldo) return null;

      if (oldDocument && oldDocument.estado !== 2) {
        if (oldDocument && oldDocument.estado !== 2 && document.estado === 2) {
          if (document.materiales) {
            await Promise.all(
                document.materiales.map((ins) => {
                  return restarMateriaPrimaTransaction(
                      empresaId,
                      ins.producto,
                      ins.cantidad,
                  );
                }),
            );
          }
        }

        if (oldDocument && oldDocument.estado !== 2) {
          console.log("se esta queriendo actualizar un pedido");
          await Promise.all(
              oldDocument.productos.map((p) => {
                // if (!p.color) return;

                const productRef = db
                    .collection("empresas")
                    .doc(empresaId)
                    .collection("stock_productos")
                    .doc(
                        p.producto +
                  (p.color !== null && p.color.length > 0 ? p.color : ""),
                    );

                return (db
                    .runTransaction((t) => {
                      return t.get(productRef).then((doc) => {
                        let newSaldo = 0;
                        if (doc && doc.data()) {
                          newSaldo =
                      (doc.data().demanda ? doc.data().demanda : 0) -
                      p.cantidad;
                        }
                        t.update(productRef, {
                          demanda: newSaldo > 0 ? newSaldo : 0,
                        });
                      });
                    })
                    .then((result) => {
                      console.log("Transaction success", result);
                    })
                    .catch((err) => {
                      console.log("Transaction failure:", err);
                    }));
              }),
          );
        } else {
          console.log("se creo un nuevo pedido");
        }

        if (oldDocument && oldDocument.estado !== 3 && document.estado === 3) {
          const pagos = await db
              .collection("empresas")
              .doc(empresaId)
              .collection("pagos")
              .where("pedido", "==", pedidoId)
              .get();
          return Promise.all(
              pagos.docs.map((p) => {
                const dataPago = p.data();
                const mov = {
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
              }),
          );
        }

        if (document.estado == 3) {
          console.log("aqui no debio haber entrado..");
        }
        /**
       * re calculando total para registrar transaccion por diferencia
       */
        let nuevoSaldo = 0;
        document.productos.map(async (p) => {
          nuevoSaldo += p.precio;
        });
        nuevoSaldo += document.flete;

        const pagos = await db
            .collection("empresas")
            .doc(empresaId)
            .collection("pagos")
            .where("pedido", "==", pedidoId)
            .get();

        if (document.materiales) {
          document.materiales.map(async (p) => {
            nuevoSaldo += p.precio;
          });
        }

        pagos.docs.map((p) => {
          const dataPago = p.data();
          nuevoSaldo = nuevoSaldo - dataPago.monto;
        });

        db.runTransaction((t) => {
          return t.get(pedidoRef).then((doc) => {
            t.update(pedidoRef, {saldo: Number(nuevoSaldo)});
          });
        });

        // fin transaccion

        // alta, reparto, entregado, suspendido, deudor

        if (document.estado !== 3) {
          return Promise.all(
              document.productos.map(async (p) => {
                // if (!p.color) return;

                const productRef = db
                    .collection("empresas")
                    .doc(empresaId)
                    .collection("stock_productos")
                    .doc(
                        p.producto +
                  (p.color !== null && p.color.length > 0 ? p.color : ""),
                    );

                const prod = await productRef.get();
                if (prod && prod.data()) {
                  return (db
                      .runTransaction((t) => {
                        return t.get(productRef).then((doc) => {
                          let newSaldo = 0;

                          if (document.estado !== 2) {
                            // actualiza demanda, volviendo a sumar la cantidad pedida

                            const newSaldo =
                        (doc.data().demanda ? doc.data().demanda : 0) +
                        p.cantidad;

                            t.update(productRef, {demanda: newSaldo});
                          } else {
                            if (oldDocument.estado !== 2) {
                              // actualiza stock, restando lo entregado, siempre y cuando el estado anterior no sea entregado (evita restar stock dos veces)
                              newSaldo =
                          (doc.data().stock ? doc.data().stock : 0) -
                          p.cantidad;
                              t.update(productRef, {stock: newSaldo});
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
              }),
          );
        } else {
          return true;
        }
      }
    });

exports.nuevousuario = functions.https.onRequest(async (req, res) => {
  console.log("inicio nuevousuario");
  const user = req.body;

  const userRecord = await admin.auth().createUser({
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
      .then((_) => {
        res.status(200).send("se dio de alta el usuario");
      })
      .catch((err) => {
        res.status(404).send(err);
      });
});
