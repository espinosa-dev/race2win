const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACHIEVEMENTS = [
  { id: "first_race", title: "Primera bandera", reward: 25, description: "Completa tu primera carrera." },
  { id: "first_win", title: "Victoria inicial", reward: 40, description: "Gana una carrera." },
  { id: "podium_3", title: "En el podio", reward: 30, description: "Consigue tres podios." },
  { id: "fastest_lap", title: "Vuelta de oro", reward: 30, description: "Registra una vuelta rápida." },
  { id: "first_purchase", title: "A estrenar", reward: 15, description: "Compra tu primer artículo." },
  { id: "all_tracks", title: "Kilómetros recorridos", reward: 35, description: "Corre en los cuatro circuitos." },
  { id: "time_trial_clear", title: "A contrarreloj", reward: 30, description: "Completa una contrarreloj." },
];

function createStorage(dataDir, catalog) {
  const accountsPath = path.join(dataDir, "accounts.json");
  const sessionsPath = path.join(dataDir, "sessions.json");
  const recordsPath = path.join(dataDir, "records.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const accounts = new Map();
  const sessions = new Map();
  const trackRecords = fs.existsSync(recordsPath)
    ? new Map(Object.entries(JSON.parse(fs.readFileSync(recordsPath, "utf8"))))
    : new Map();
  if (fs.existsSync(accountsPath)) {
    const storedAccounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    for (const account of storedAccounts) {
      account.achievements = Array.isArray(account.achievements) ? account.achievements : [];
      account.progress = account.progress || { tracksPlayed: [], timeTrialsCompleted: 0 };
      account.progress.tracksPlayed = Array.isArray(account.progress.tracksPlayed)
        ? account.progress.tracksPlayed
        : [];
      account.progress.timeTrialsCompleted = Number(account.progress.timeTrialsCompleted) || 0;
      account.personalRecords = account.personalRecords || {};
      accounts.set(account.username.toLowerCase(), account);
    }
  }

  if (fs.existsSync(sessionsPath)) {
    const storedSessions = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    for (const [digest, session] of storedSessions) {
      if (
        /^[a-f0-9]{64}$/.test(digest)
        && Number.isFinite(session?.expiresAt)
        && session.expiresAt > Date.now()
        && accounts.has(String(session.username || "").toLowerCase())
      ) {
        sessions.set(digest, session);
      }
    }
  }

  function persist() {
    const temporaryPath = `${accountsPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...accounts.values()], null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, accountsPath);
  }

  function persistSessions() {
    const temporaryPath = `${sessionsPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify([...sessions.entries()], null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, sessionsPath);
  }

  function persistRecords() {
    const temporaryPath = `${recordsPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(trackRecords), null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, recordsPath);
  }

  persistSessions();

  function publicProfile(account) {
    if (!account) return null;
    return {
      username: account.username,
      coins: account.coins,
      inventory: [...account.inventory],
      equipped: { ...account.equipped },
      stats: { ...account.stats },
      achievements: [...account.achievements],
      progress: {
        tracksPlayed: [...account.progress.tracksPlayed],
        timeTrialsCompleted: account.progress.timeTrialsCompleted,
      },
      personalRecords: { ...account.personalRecords },
    };
  }

  function unlockAchievements(account, conditionIds) {
    const newlyUnlocked = [];
    for (const achievement of ACHIEVEMENTS) {
      if (conditionIds.includes(achievement.id) && !account.achievements.includes(achievement.id)) {
        account.achievements.push(achievement.id);
        account.coins += achievement.reward;
        newlyUnlocked.push({ ...achievement });
      }
    }
    return newlyUnlocked;
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
      persistSessions();
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
    persistSessions();
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
      achievements: [],
      progress: { tracksPlayed: [], timeTrialsCompleted: 0 },
      personalRecords: {},
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
    if (digest && sessions.delete(digest)) persistSessions();
  }

  function leaderboard() {
    return [...accounts.values()]
      .sort((first, second) => (
        second.stats.points - first.stats.points
        || second.stats.wins - first.stats.wins
        || first.username.localeCompare(second.username)
      ))
      .slice(0, 10)
      .map((account) => ({
        username: account.username,
        points: account.stats.points,
        wins: account.stats.wins,
        podiums: account.stats.podiums,
        racesPlayed: account.stats.racesPlayed,
        bestLapMs: account.stats.bestLapMs,
      }));
  }

  function buyItem(username, item) {
    const account = accounts.get(String(username).toLowerCase());
    if (!account) return { ok: false, status: 401, error: "Inicia sesión para comprar." };
    if (account.inventory.includes(item.id)) return { ok: false, status: 409, error: "Ya tienes este artículo." };
    if (account.coins < item.price) return { ok: false, status: 400, error: "No tienes suficientes RC." };
    account.coins -= item.price;
    account.inventory.push(item.id);
    const achievements = unlockAchievements(account, ["first_purchase"]);
    persist();
    return { ok: true, profile: publicProfile(account), achievements };
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
    if (!account) return { achievements: [] };
    account.coins += result.coins;
    account.stats.racesPlayed += 1;
    account.stats.points += result.points;
    if (result.place === 1) account.stats.wins += 1;
    if (result.place <= 3) account.stats.podiums += 1;
    if (result.trackId && !account.progress.tracksPlayed.includes(result.trackId)) {
      account.progress.tracksPlayed.push(result.trackId);
    }
    if (Number.isFinite(result.bestLapMs)) {
      account.stats.bestLapMs = account.stats.bestLapMs === null
        ? result.bestLapMs
        : Math.min(account.stats.bestLapMs, result.bestLapMs);
    }
    const conditionIds = [];
    if (account.stats.racesPlayed >= 1) conditionIds.push("first_race");
    if (result.place === 1) conditionIds.push("first_win");
    if (account.stats.podiums >= 3) conditionIds.push("podium_3");
    if (result.fastestLapBonus) conditionIds.push("fastest_lap");
    if (account.progress.tracksPlayed.length >= 4) conditionIds.push("all_tracks");
    const achievements = unlockAchievements(account, conditionIds);
    persist();
    return { achievements, profile: publicProfile(account) };
  }

  function recordTimeTrial(trackId, username, timeMs, samples) {
    if (!Number.isFinite(timeMs) || timeMs <= 0 || !Array.isArray(samples)) {
      throw new Error("El registro de contrarreloj no es válido.");
    }
    const currentRecord = trackRecords.get(trackId);
    const isTrackRecord = !currentRecord || timeMs < currentRecord.bestLapMs;
    if (isTrackRecord) {
      trackRecords.set(trackId, {
        bestLapMs: timeMs,
        samples: samples.slice(0, 3000),
        updatedAt: Date.now(),
      });
      persistRecords();
    }
    const account = username ? accounts.get(String(username).toLowerCase()) : null;
    let isPersonalRecord = false;
    let achievements = [];
    if (account) {
      const currentPersonal = account.personalRecords[trackId];
      isPersonalRecord = !Number.isFinite(currentPersonal) || timeMs < currentPersonal;
      if (isPersonalRecord) {
        account.personalRecords[trackId] = timeMs;
        account.coins += 50 + (isTrackRecord ? 25 : 0);
        account.stats.points += 50 + (isTrackRecord ? 25 : 0);
      }
      if (!account.progress.tracksPlayed.includes(trackId)) account.progress.tracksPlayed.push(trackId);
      account.progress.timeTrialsCompleted += 1;
      const conditionIds = ["time_trial_clear"];
      if (account.progress.tracksPlayed.length >= 4) conditionIds.push("all_tracks");
      achievements = unlockAchievements(account, conditionIds);
      persist();
    }
    return {
      isTrackRecord,
      isPersonalRecord,
      bestLapMs: trackRecords.get(trackId)?.bestLapMs || null,
      achievements,
      profile: account ? publicProfile(account) : null,
    };
  }

  function getTrackRecord(trackId, username) {
    const record = trackRecords.get(trackId);
    const account = username ? accounts.get(String(username).toLowerCase()) : null;
    return {
      bestLapMs: record?.bestLapMs || null,
      samples: record?.samples || [],
      personalBestMs: account?.personalRecords?.[trackId] || null,
    };
  }

  return {
    register,
    login,
    logout,
    getSession,
    leaderboard,
    publicProfile,
    buyItem,
    equipItem,
    recordRace,
    recordTimeTrial,
    getTrackRecord,
    achievements: () => ACHIEVEMENTS.map((achievement) => ({ ...achievement })),
  };
}

module.exports = { createStorage };
