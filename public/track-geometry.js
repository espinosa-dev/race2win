(function exposeTrackGeometry(root) {
  function crosses(a, b, c, d) {
    const orientation = (first, second, point) => (
      (second[0] - first[0]) * (point[1] - first[1])
      - (second[1] - first[1]) * (point[0] - first[0])
    );
    const first = orientation(a, b, c);
    const second = orientation(a, b, d);
    const third = orientation(c, d, a);
    const fourth = orientation(c, d, b);
    return first * second < 0 && third * fourth < 0;
  }

  function getSmoothedTrack(track, subdivisions = 4) {
    if (track.geometryVersion === 1) return track;
    const controls = track.points;
    const controlCount = controls.length;
    const startIndex = ((Math.trunc(track.startIndex || 0) % controlCount) + controlCount) % controlCount;
    const scale = Number.isFinite(track.scale) ? track.scale : 1;
    const points = [];
    for (let control = 0; control < controlCount; control += 1) {
      const currentIndex = (startIndex + control) % controlCount;
      const p0 = controls[(currentIndex - 1 + controlCount) % controlCount];
      const p1 = controls[currentIndex];
      const p2 = controls[(currentIndex + 1) % controlCount];
      const p3 = controls[(currentIndex + 2) % controlCount];
      for (let step = 0; step < subdivisions; step += 1) {
        const t = step / subdivisions;
        const t2 = t * t;
        const t3 = t2 * t;
        const sample = [0, 0];
        for (let axis = 0; axis < 2; axis += 1) {
          sample[axis] = scale * 0.5 * (
            2 * p1[axis]
            + (-p0[axis] + p2[axis]) * t
            + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2
            + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3
          );
        }
        points.push(sample);
      }
    }
    return { ...track, points, startIndex: 0, scale: 1, geometryVersion: 1 };
  }

  function buildEdges(track, halfWidths) {
    const count = track.points.length;
    return track.points.map((point, index) => {
      const previous = track.points[(index - 1 + count) % count];
      const next = track.points[(index + 1) % count];
      const incomingX = point[0] - previous[0];
      const incomingZ = point[1] - previous[1];
      const outgoingX = next[0] - point[0];
      const outgoingZ = next[1] - point[1];
      const incomingLength = Math.hypot(incomingX, incomingZ) || 1;
      const outgoingLength = Math.hypot(outgoingX, outgoingZ) || 1;
      const incomingNormalX = incomingZ / incomingLength;
      const incomingNormalZ = -incomingX / incomingLength;
      const outgoingNormalX = outgoingZ / outgoingLength;
      const outgoingNormalZ = -outgoingX / outgoingLength;
      let miterX = incomingNormalX + outgoingNormalX;
      let miterZ = incomingNormalZ + outgoingNormalZ;
      const miterLength = Math.hypot(miterX, miterZ);
      if (miterLength < 1e-6) {
        miterX = outgoingNormalX;
        miterZ = outgoingNormalZ;
      } else {
        miterX /= miterLength;
        miterZ /= miterLength;
      }
      const denominator = Math.max(
        0.25,
        Math.abs(miterX * outgoingNormalX + miterZ * outgoingNormalZ)
      );
      const halfWidth = halfWidths[index];
      const offset = Math.min(halfWidth / denominator, halfWidth * 1.5);
      const offsetX = miterX * offset;
      const offsetZ = miterZ * offset;
      return {
        left: [point[0] + offsetX, point[1] + offsetZ],
        right: [point[0] - offsetX, point[1] - offsetZ],
        width: offset * denominator * 2,
      };
    });
  }

  function getTrackEdges(track) {
    const count = track.points.length;
    const halfWidths = Array(count).fill(track.width / 2);
    let edges = buildEdges(track, halfWidths);

    for (let iteration = 0; iteration < 64; iteration += 1) {
      const intersections = [];
      for (const side of ["left", "right"]) {
        for (let first = 0; first < count; first += 1) {
          for (let second = first + 2; second < count; second += 1) {
            if (first === 0 && second === count - 1) continue;
            if (crosses(
              edges[first][side],
              edges[(first + 1) % count][side],
              edges[second][side],
              edges[(second + 1) % count][side]
            )) {
              intersections.push([first, second]);
            }
          }
        }
      }
      if (intersections.length === 0) break;
      for (const [first, second] of intersections) {
        for (const index of [first, (first + 1) % count, second, (second + 1) % count]) {
          halfWidths[index] *= 0.9;
        }
      }
      edges = buildEdges(track, halfWidths);
    }

    return edges;
  }

  const api = { getSmoothedTrack, getTrackEdges };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RaceTrackGeometry = api;
}(globalThis));
