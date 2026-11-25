import * as THREE from "/vendor/three.module.js";

const joinScreen = document.querySelector("#join-screen");
const raceScreen = document.querySelector("#race-screen");
const joinForm = document.querySelector("#join-form");
const joinError = document.querySelector("#join-error");
const connectionLabel = document.querySelector("#connection-label");
const gameView = document.querySelector("#game-view");
const startButton = document.querySelector("#start-button");
const restartButton = document.querySelector("#restart-button");
const leaveButton = document.querySelector("#leave-button");
const raceMessage = document.querySelector("#race-message");
const standingsList = document.querySelector("#standings-list");
const raceClock = document.querySelector("#race-clock");
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 350);
const clock = new THREE.Clock();
const carViews = new Map();
const heldKeys = new Set();
let socket;
let playerId = null;
let latestState = null;
let sceneReady = false;
let lastSentInput = { throttle: 0, brake: 0, steer: 0 };
let lastLeaderboardSignature = "";
let lastLeaderboardUpdate = 0;
let lastRenderedPhase = null;
let raceElapsedMs = 0;
let raceClockSyncAt = 0;
let raceClockRunning = false;
let lastClockUpdateAt = 0;

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
gameView.appendChild(renderer.domElement);

function seededNoise(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeTexture(baseColor, marks, seed, repeat = 1, surface = "asphalt") {
  const canvas = document.createElement("canvas");
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const random = seededNoise(seed);
  context.fillStyle = baseColor;
  context.fillRect(0, 0, size, size);

  for (let index = 0; index < 68; index += 1) {
    const radiusX = 5 + random() * 18;
    const radiusY = 4 + random() * 14;
    const centerX = random() * size;
    const centerY = random() * size;
    const vertices = [];
    const vertexCount = 5 + Math.floor(random() * 4);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const angle = (vertex / vertexCount) * Math.PI * 2;
      const variation = 0.65 + random() * 0.5;
      vertices.push([
        centerX + Math.cos(angle) * radiusX * variation,
        centerY + Math.sin(angle) * radiusY * variation,
      ]);
    }

    const xOffsets = [0];
    const yOffsets = [0];
    const patchAlpha = 0.035 + random() * 0.055;
    const patchColor = marks[Math.floor(random() * marks.length)];
    if (centerX < radiusX) xOffsets.push(size);
    if (centerX > size - radiusX) xOffsets.push(-size);
    if (centerY < radiusY) yOffsets.push(size);
    if (centerY > size - radiusY) yOffsets.push(-size);
    for (const offsetX of xOffsets) {
      for (const offsetY of yOffsets) {
        context.beginPath();
        vertices.forEach(([x, y], vertex) => {
          if (vertex === 0) context.moveTo(x + offsetX, y + offsetY);
          else context.lineTo(x + offsetX, y + offsetY);
        });
        context.closePath();
        context.globalAlpha = patchAlpha;
        context.fillStyle = patchColor;
        context.fill();
      }
    }
  }

  for (let index = 0; index < 3200; index += 1) {
    const x = random() * size;
    const y = random() * size;
    const detailSize = 1 + random() * 2;
    context.globalAlpha = 0.08 + random() * 0.14;
    context.fillStyle = marks[Math.floor(random() * marks.length)];
    if (surface === "grass") {
      const angle = random() * Math.PI * 2;
      const length = 2 + random() * 5;
      context.strokeStyle = context.fillStyle;
      context.lineWidth = 0.6 + random() * 0.6;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      context.stroke();
    } else {
      context.fillRect(x, y, detailSize, detailSize);
    }
  }
  context.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
  return texture;
}

function addCircleLine(radius, color, y, segments = 180, dashed = false) {
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 1.1, gapSize: 0.75, transparent: true, opacity: 0.8 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
  const points = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.LineLoop(geometry, material);
  if (dashed) line.computeLineDistances();
  scene.add(line);
}

function createTrees() {
  const count = 48;
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.18, 0.24, 1.2, 5),
    new THREE.MeshStandardMaterial({ color: "#775238", flatShading: true }),
    count
  );
  const foliage = [0, 1, 2].map((layer) => new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.05 - layer * 0.19, 1.45, 5),
    new THREE.MeshStandardMaterial({ color: layer === 1 ? "#297967" : "#358b70", flatShading: true }),
    count
  ));
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scaleVector = new THREE.Vector3();
  const rotation = new THREE.Quaternion();

  for (let index = 0; index < count; index += 1) {
    const angle = index * 2.399;
    const radius = 43 + (index % 4) * 6;
    const scale = 0.75 + (index % 3) * 0.18;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    scaleVector.setScalar(scale);
    position.set(x, 0.6 * scale, z);
    matrix.compose(position, rotation, scaleVector);
    trunks.setMatrixAt(index, matrix);

    for (let layer = 0; layer < foliage.length; layer += 1) {
      position.set(x, (1.45 + layer * 0.78) * scale, z);
      matrix.compose(position, rotation, scaleVector);
      foliage[layer].setMatrixAt(index, matrix);
    }
  }

  trunks.instanceMatrix.needsUpdate = true;
  scene.add(trunks, ...foliage);
}

function createTrack() {
  scene.background = new THREE.Color("#a8d7dc");
  scene.fog = new THREE.Fog("#a8d7dc", 95, 190);
  const ambient = new THREE.HemisphereLight("#e3f6e8", "#536e5c", 2.1);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight("#fff5d5", 3.2);
  sun.position.set(-38, 57, -22);
  scene.add(sun);

  const grassTexture = makeTexture("#72b982", ["#4fa676", "#97cb79", "#b2d27e", "#8dc988"], 28, 20, "grass");
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(230, 230),
    new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.15;
  scene.add(ground);

  const centerPatch = new THREE.Mesh(
    new THREE.CircleGeometry(18.9, 100),
    new THREE.MeshStandardMaterial({ color: "#94c97d", roughness: 1 })
  );
  centerPatch.rotation.x = -Math.PI / 2;
  centerPatch.position.y = -0.04;
  scene.add(centerPatch);

  const asphalt = makeTexture("#565f61", ["#70797a", "#40494c", "#838887", "#646e70"], 91, 8, "asphalt");
  const road = new THREE.Mesh(
    new THREE.RingGeometry(19, 34, 128),
    new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95, side: THREE.DoubleSide })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.015;
  scene.add(road);
  addCircleLine(19.2, "#f7f0dc", 0.09);
  addCircleLine(33.8, "#f7f0dc", 0.09);
  addCircleLine(26.5, "#e5d58b", 0.08, 180, true);

  const barrierCount = 64;
  const barriers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.55, 0.72, 0.6),
    new THREE.MeshStandardMaterial({ color: "#f5eee0", flatShading: true }),
    barrierCount
  );
  const barrierMatrix = new THREE.Matrix4();
  const barrierPosition = new THREE.Vector3();
  const barrierRotation = new THREE.Quaternion();
  const barrierScale = new THREE.Vector3(1, 1, 1);
  for (let index = 0; index < barrierCount; index += 1) {
    const angle = (index / 64) * Math.PI * 2;
    const radius = 34.3;
    barrierPosition.set(Math.cos(angle) * radius, 0.36, Math.sin(angle) * radius);
    barrierRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
    barrierMatrix.compose(barrierPosition, barrierRotation, barrierScale);
    barriers.setMatrixAt(index, barrierMatrix);
    barriers.setColorAt(index, new THREE.Color(index % 2 ? "#f5eee0" : "#e87662"));
  }
  barriers.instanceMatrix.needsUpdate = true;
  if (barriers.instanceColor) barriers.instanceColor.needsUpdate = true;
  scene.add(barriers);

  const startLine = new THREE.Group();
  const tileMaterialA = new THREE.MeshStandardMaterial({ color: "#fff8e4", flatShading: true });
  const tileMaterialB = new THREE.MeshStandardMaterial({ color: "#34474a", flatShading: true });
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 18; col += 1) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.07, 0.8),
        (row + col) % 2 ? tileMaterialA : tileMaterialB
      );
      tile.position.set((row - 0.5) * 0.8, 0.1, -26 + (col - 8.5) * 0.83);
      startLine.add(tile);
    }
  }
  scene.add(startLine);

  const island = new THREE.Mesh(
    new THREE.CylinderGeometry(10.2, 10.5, 0.5, 9),
    new THREE.MeshStandardMaterial({ color: "#80b873", flatShading: true })
  );
  island.position.y = 0.08;
  scene.add(island);
  const sign = new THREE.Group();
  const signBoard = new THREE.Mesh(
    new THREE.BoxGeometry(8, 2.4, 0.55),
    new THREE.MeshStandardMaterial({ color: "#18393b", flatShading: true })
  );
  signBoard.position.y = 4;
  signBoard.castShadow = true;
  sign.add(signBoard);
  const signAccent = new THREE.Mesh(
    new THREE.BoxGeometry(6.7, 0.13, 0.59),
    new THREE.MeshStandardMaterial({ color: "#30d6c1", emissive: "#0c574f", flatShading: true })
  );
  signAccent.position.set(0, 3.12, 0);
  sign.add(signAccent);
  for (const x of [-3.1, 3.1]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 3.5, 0.24),
      new THREE.MeshStandardMaterial({ color: "#efb256", flatShading: true })
    );
    post.position.set(x, 1.8, 0);
    sign.add(post);
  }
  sign.position.set(0, 0, 0);
  sign.rotation.y = 0;
  scene.add(sign);

  const flowerColors = ["#f1bd61", "#e98773", "#f2e9bf"];
  const flowerCount = 24;
  const flowers = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.28, 0),
    new THREE.MeshStandardMaterial({ color: "#f1bd61", flatShading: true }),
    flowerCount
  );
  const flowerMatrix = new THREE.Matrix4();
  const flowerPosition = new THREE.Vector3();
  const flowerScale = new THREE.Vector3();
  for (let index = 0; index < flowerCount; index += 1) {
    const angle = index * 2.399;
    const radius = 3 + (index % 5) * 1.2;
    const size = 0.8 + (index % 3) * 0.28;
    flowerPosition.set(Math.cos(angle) * radius, 0.45, Math.sin(angle) * radius);
    flowerScale.setScalar(size);
    flowerMatrix.compose(flowerPosition, new THREE.Quaternion(), flowerScale);
    flowers.setMatrixAt(index, flowerMatrix);
    flowers.setColorAt(index, new THREE.Color(flowerColors[index % flowerColors.length]));
  }
  flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;
  scene.add(flowers);

  createTrees();

  const startPost = new THREE.Group();
  for (const z of [-18.8, -33.2]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 4.2, 0.45),
      new THREE.MeshStandardMaterial({ color: "#f0ac51", flatShading: true })
    );
    post.position.set(0, 2.1, z);
    startPost.add(post);
  }
  const banner = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 14.5),
    new THREE.MeshStandardMaterial({ color: "#183b3b", flatShading: true })
  );
  banner.position.set(0, 4.1, -26);
  startPost.add(banner);
  scene.add(startPost);
}

function createCar(color) {
  const car = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.53, metalness: 0.08, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: "#17292b", roughness: 0.8, flatShading: true });
  const accent = new THREE.MeshStandardMaterial({ color: "#f4f0dc", emissive: "#554d38", flatShading: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.52, 3.35), paint);
  body.position.y = 0.65;
  car.add(body);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.22, 0.72), paint);
  nose.position.set(0, 0.84, -1.23);
  car.add(nose);
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.58, 1.22), dark);
  cockpit.position.set(0, 1.04, 0.17);
  car.add(cockpit);
  const driver = new THREE.Mesh(
    new THREE.SphereGeometry(0.43, 9, 7),
    new THREE.MeshStandardMaterial({ color: "#f2c394", flatShading: true })
  );
  driver.position.set(0, 1.43, 0.05);
  car.add(driver);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.49, 9, 7),
    new THREE.MeshStandardMaterial({ color, flatShading: true })
  );
  helmet.position.set(0, 1.72, 0.02);
  car.add(helmet);

  const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.38, 0.38, 0.28, 9), dark, 4);
  const wheelMatrix = new THREE.Matrix4();
  const wheelPosition = new THREE.Vector3();
  const wheelRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const wheelScale = new THREE.Vector3(1, 1, 1);
  let wheelIndex = 0;
  for (const x of [-1.03, 1.03]) {
    for (const z of [-1.05, 1.04]) {
      wheelPosition.set(x, 0.4, z);
      wheelMatrix.compose(wheelPosition, wheelRotation, wheelScale);
      wheels.setMatrixAt(wheelIndex, wheelMatrix);
      wheelIndex += 1;
    }
  }
  wheels.instanceMatrix.needsUpdate = true;
  car.add(wheels);
  const lights = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.14, 0.08), accent);
  lights.position.set(0, 0.78, -1.71);
  car.add(lights);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.13, 0.35), paint);
  spoiler.position.set(0, 1.12, 1.58);
  car.add(spoiler);
  return car;
}

function resizeRenderer() {
  const width = Math.max(gameView.clientWidth, 1);
  const height = Math.max(gameView.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function shortestAngle(from, to) {
  let difference = to - from;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function renderFrame() {
  requestAnimationFrame(renderFrame);
  const dt = Math.min(clock.getDelta(), 0.06);
  for (const carView of carViews.values()) {
    carView.mesh.position.lerp(carView.targetPosition, Math.min(1, dt * 8));
    const yawDifference = shortestAngle(carView.mesh.rotation.y, carView.targetYaw);
    carView.mesh.rotation.y += yawDifference * Math.min(1, dt * 8);
  }

  const playerCar = playerId ? carViews.get(playerId) : null;
  if (playerCar) {
    const cameraTarget = playerCar.mesh.localToWorld(new THREE.Vector3(0, 5.2, 10));
    camera.position.lerp(cameraTarget, Math.min(1, dt * 2.7));
    camera.lookAt(playerCar.mesh.position.x, 1.2, playerCar.mesh.position.z);
  }
  updateRaceClock(performance.now());
  renderer.render(scene, camera);
}

function initializeScene() {
  if (sceneReady) return;
  sceneReady = true;
  createTrack();
  resizeRenderer();
  renderFrame();
}

function updateLeaderboard(cars) {
  standingsList.replaceChildren();
  for (const car of cars) {
    const row = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(car.place).padStart(2, "0");
    const swatch = document.createElement("span");
    swatch.className = "driver-swatch";
    swatch.style.backgroundColor = car.color;
    const name = document.createElement("span");
    name.textContent = `${car.name}${car.isBot ? " · IA" : ""}`;
    const lap = document.createElement("span");
    lap.className = "driver-lap";
    if (car.finished) {
      lap.textContent = car.isFirstFinisher
        ? `🏁 ${formatRaceTime(car.finishTimeMs)}`
        : `🏁 +${(car.gapMs / 1000).toFixed(2)}`;
      lap.setAttribute("aria-label", car.isFirstFinisher ? "Ganador, tiempo final" : "Terminado, diferencia con el ganador");
      row.classList.add("is-finished");
      if (car.isFirstFinisher) row.classList.add("is-winner");
    } else {
      lap.textContent = `${Math.min(car.lap, 3)}/3`;
    }
    row.append(rank, swatch, name, lap);
    standingsList.appendChild(row);
  }
}

function formatRaceTime(milliseconds) {
  const centiseconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 10);
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor(centiseconds / 100) % 60;
  const remainder = centiseconds % 100;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(2, "0")}`;
}

function updateRaceClock(now) {
  if (now - lastClockUpdateAt < 50) return;
  const elapsed = raceElapsedMs + (raceClockRunning ? now - raceClockSyncAt : 0);
  const text = formatRaceTime(elapsed);
  if (raceClock.textContent !== text) raceClock.textContent = text;
  lastClockUpdateAt = now;
}

function onRaceState(state) {
  const previousPhase = latestState?.phase;
  latestState = state;
  raceElapsedMs = Number(state.raceElapsedMs) || 0;
  raceClockSyncAt = performance.now();
  raceClockRunning = state.phase === "racing";
  if (state.phase !== previousPhase) readControls();
  initializeScene();
  const seenIds = new Set();
  for (const car of state.cars) {
    seenIds.add(car.id);
    let carView = carViews.get(car.id);
    if (!carView) {
      const mesh = createCar(car.color);
      scene.add(mesh);
      carView = {
        mesh,
        targetPosition: new THREE.Vector3(car.x, 0, car.z),
        targetYaw: car.yaw,
      };
      carViews.set(car.id, carView);
    }
    carView.targetPosition.set(car.x, 0, car.z);
    carView.targetYaw = car.yaw;
    if (car.id === playerId) {
      document.querySelector("#speed-value").textContent = String(Math.round(car.speed * 5.3)).padStart(2, "0");
      document.querySelector("#lap-number").textContent = String(car.lap);
      document.querySelector("#place-number").textContent = String(car.place);
      document.querySelector("#place-suffix").textContent = car.place === 1 ? "º" : "º";
    }
  }
  for (const [id, carView] of carViews) {
    if (!seenIds.has(id)) {
      scene.remove(carView.mesh);
      carViews.delete(id);
    }
  }

  const signature = state.cars.map((car) => `${car.id}:${car.place}:${car.lap}:${car.finished}`).join("|");
  const now = performance.now();
  if (signature !== lastLeaderboardSignature && (state.phase !== lastRenderedPhase || now - lastLeaderboardUpdate >= 250)) {
    updateLeaderboard(state.cars);
    lastLeaderboardSignature = signature;
    lastLeaderboardUpdate = now;
  }
  lastRenderedPhase = state.phase;
  const isHost = state.hostId === playerId;
  startButton.classList.toggle("is-hidden", !(isHost && state.phase === "lobby"));
  restartButton.classList.toggle("is-hidden", !(isHost && state.phase === "finished"));
  document.querySelector("#race-state-label").textContent = ({
    lobby: "SALA",
    countdown: "LISTOS",
    racing: "EN CARRERA",
    finished: "FINAL",
  })[state.phase];
  if (state.phase === "lobby") {
    raceMessage.textContent = isHost ? "¿LISTOS?" : "ESPERANDO";
  } else if (state.phase === "countdown") {
    raceMessage.textContent = state.countdown > 0 ? String(state.countdown) : "¡YA!";
  } else if (state.phase === "racing") {
    raceMessage.textContent = "";
  } else {
    const winner = state.cars[0];
    raceMessage.textContent = winner ? `${winner.name} GANA` : "¡META!";
  }
}

function readControls() {
  const steer = (heldKeys.has("ArrowRight") || heldKeys.has("d") ? 1 : 0)
    - (heldKeys.has("ArrowLeft") || heldKeys.has("a") ? 1 : 0);
  const throttle = heldKeys.has("ArrowUp") || heldKeys.has("w") ? 1 : 0;
  const brake = heldKeys.has("ArrowDown") || heldKeys.has("s") ? 1 : 0;
  if (
    socket?.connected
    && latestState?.phase === "racing"
    && (throttle !== lastSentInput.throttle || brake !== lastSentInput.brake || steer !== lastSentInput.steer)
  ) {
    socket.emit("driverInput", { throttle, brake, steer });
    lastSentInput = { throttle, brake, steer };
  }
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinError.textContent = "";
  const formData = new FormData(joinForm);
  socket = window.io();
  connectionLabel.textContent = "CONECTANDO";
  socket.on("connect", () => {
    connectionLabel.textContent = "CONECTADO";
    socket.emit("joinRace", {
      name: formData.get("name"),
      botCount: Number(formData.get("botCount")),
    }, (result) => {
      if (!result?.ok) {
        joinError.textContent = result?.error || "No se pudo entrar en la sala.";
        socket.disconnect();
        return;
      }
      playerId = result.id;
      joinScreen.classList.add("is-hidden");
      raceScreen.classList.remove("is-hidden");
      resizeRenderer();
    });
  });
  socket.on("connect_error", () => {
    connectionLabel.textContent = "SIN CONEXIÓN";
    joinError.textContent = "No se pudo conectar con el servidor local.";
  });
  socket.on("raceState", onRaceState);
});

startButton.addEventListener("click", () => socket?.emit("startRace"));
restartButton.addEventListener("click", () => socket?.emit("restartRace"));
leaveButton.addEventListener("click", () => {
  socket?.disconnect();
  socket = null;
  playerId = null;
  latestState = null;
  heldKeys.clear();
  lastSentInput = { throttle: 0, brake: 0, steer: 0 };
  joinScreen.classList.remove("is-hidden");
  raceScreen.classList.add("is-hidden");
  joinError.textContent = "";
  connectionLabel.textContent = "SERVIDOR LOCAL";
});

window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  heldKeys.add(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  readControls();
});
window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  readControls();
});
window.addEventListener("blur", () => {
  heldKeys.clear();
  readControls();
});
window.addEventListener("resize", resizeRenderer);

fetch("/api/info")
  .then((response) => response.json())
  .then((info) => {
    if (info.lanUrls?.length) {
      const lanMessage = document.querySelector(".lan-note span:last-child");
      lanMessage.textContent = `En la misma Wi-Fi, tus amigos pueden entrar en ${info.lanUrls[0]}.`;
    }
  })
  .catch((error) => console.warn("No se pudo consultar la dirección de la red local.", error));
