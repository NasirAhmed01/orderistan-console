const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);
module.exports = async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000, socketTimeoutMS: 45000 });
  // email is optional: replace the legacy unique index by the partial one defined in models.js (harmless when already done).
  try {
    const col = mongoose.connection.collection("users");
    const old = (await col.indexes().catch(() => [])).find((i) => i.name === "email_1" && !i.partialFilterExpression);
    if (old) await col.dropIndex("email_1").catch(() => {});
  } catch {}
};
