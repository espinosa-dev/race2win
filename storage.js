const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createStorage(dataDir, catalog) {
  const accountsPath = path.join(dataDir, "accounts.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const accounts = new Map();
  const sessions = new Map();
  if (fs.existsSync(accountsPath)) {
    const storedAccounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    for (const account of storedAccounts) {
      accounts.set(account.username.toLowerCase(), account);
    }
  }

  function persist() {
    const temporaryPath = `${accountsPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...accounts.values()], null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, accountsPath);
  }

  function publicProfile(account) {
    if (!account) return null;
    return {
      username: account.username,
      coins: account.coins,
      inventory: [...account.inventory],
      equipped: { ...account.equipped },
      stats: { ...account.stats },
    };
  }

  function tokenDigest(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  function getSession(token) {
    const digest = tokenDigest(token);
    if (!digest) return null;
    const session = sessions.get(digest);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(digest);
      return null;
    }
    return accounts.get(session.username.toLowerCase()) || null;
  }

  function issueSession(account) {
    const token = crypto.randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);
    sessions.set(digest, {
      username: account.username,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  }

  async function register(usernameInput, password) {
    const username = String(usernameInput || "").trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      const error = new Error("El usuario debe tener entre 3 y 16 caracteres (letras, números o _).");
      error.status = 400;
      throw error;
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      const error = new Error("La contraseña debe tener entre 8 y 128 caracteres.");
      error.status = 400;
      throw error;
    }
    const accountKey = username.toLowerCase();
    if (accounts.has(accountKey)) {
      const error = new Error("Ese nombre de usuario ya está registrado.");
      error.status = 409;
      throw error;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, KEY_LENGTH)).toString("hex");
    if (accounts.has(accountKey)) {
      const error = new Error("Ese nombre de usuario ya está registrado.");
      error.status = 409;
      throw error;
    }
    const account = {
      username,
      salt,
      passwordHash,
      coins: 500,
      inventory: Object.values(catalog.defaults),
      equipped: { ...catalog.defaults },
      stats: { racesPlayed: 0, wins: 0, podiums: 0, bestLapMs: null, points: 0 },
    };
    accounts.set(accountKey, account);
    persist();
    return { token: issueSession(account), profile: publicProfile(account) };
  }

  async function login(usernameInput, password) {
    const username = String(usernameInput || "").trim();
    const account = accounts.get(username.toLowerCase());
    const salt = account?.salt || "race2win-invalid-account-salt";
    const expectedHash = account?.passwordHash || "0".repeat(KEY_LENGTH * 2);
    const actualHash = (await scrypt(typeof password === "string" ? password : "", salt, KEY_LENGTH)).toString("hex");
    const expected = Buffer.from(expectedHash, "hex");
    const actual = Buffer.from(actualHash, "hex");
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!account || !valid) {
      const error = new Error("Usuario o contraseña incorrectos.");
      error.status = 401;
      throw error;
    }
    return { token: issueSession(account), profile: publicProfile(account) };
  }

  function logout(token) {
    const digest = tokenDigest(token);
    if (digest) sessions.delete(digest);
  }

  function buyItem(username, item) {
    const account = accounts.get(String(username).toLowerCase());
    if (!account) return { ok: false, status: 401, error: "Inicia sesión para comprar." };
    if (account.inventory.includes(item.id)) return { ok: false, status: 409, error: "Ya tienes este artículo." };
    if (account.coins < item.price) return { ok: false, status: 400, error: "No tienes suficientes RC." };
    account.coins -= item.price;
    account.inventory.push(item.id);
    persist();
    return { ok: true, profile: publicProfile(account) };
  }

  function equipItem(username, category, item) {
    const account = accounts.get(String(username).toLowerCase());
    if (!account) return { ok: false, status: 401, error: "Inicia sesión para equipar artículos." };
    if (!account.inventory.includes(item.id)) return { ok: false, status: 403, error: "No tienes este artículo." };
    account.equipped[category] = item.id;
    persist();
    return { ok: true, profile: publicProfile(account) };
  }

  function recordRace(username, result) {
    const account = accounts.get(String(username).toLowerCase());
    if (!account) return;
    account.coins += result.coins;
    account.stats.racesPlayed += 1;
    account.stats.points += result.points;
    if (result.place === 1) account.stats.wins += 1;
    if (result.place <= 3) account.stats.podiums += 1;
    if (Number.isFinite(result.bestLapMs)) {
      account.stats.bestLapMs = account.stats.bestLapMs === null
        ? result.bestLapMs
        : Math.min(account.stats.bestLapMs, result.bestLapMs);
    }
    persist();
  }

  return {
    register,
    login,
    logout,
    getSession,
    publicProfile,
    buyItem,
    equipItem,
    recordRace,
  };
}

module.exports = { createStorage };
