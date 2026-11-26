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

  const api = { getTrackEdges };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RaceTrackGeometry = api;
}(globalThis));
