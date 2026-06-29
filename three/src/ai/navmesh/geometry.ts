// Pure, render-independent triangle-mesh helpers for navmesh INPUT geometry.
// No three.js / DOM imports — this mirrors the `measure/probe` idiom: a pure
// core that is fully unit-testable headless (no GPU, no window). The Three.js
// visualization lives separately in `debugView.ts`, used only inside a Sample's
// mount(ctx).

/** A point / direction in world space. Matches recast-navigation's Vector3 DTO. */
export type Vec3 = { x: number; y: number; z: number };

/** Axis-aligned bounding box projected onto the XZ plane (a navmesh footprint). */
export type AabbXZ = { minX: number; maxX: number; minZ: number; maxZ: number };

/**
 * A flat triangle soup: `positions` is xyz triples, `indices` is triangle
 * triples into `positions`. This is exactly the (positions, indices) pair that
 * recast-navigation's generators consume.
 */
export type TriMesh = { positions: Float32Array; indices: Uint32Array };

// Unit-box corner table (8 corners), ordered so the face table below winds each
// triangle counter-clockwise when viewed from outside → outward-facing normals.
// Recast's `markWalkableTriangles` keeps the top face (upward normal) walkable.
const UNIT_BOX_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1], // 0
  [1, -1, -1], // 1
  [1, -1, 1], // 2
  [-1, -1, 1], // 3
  [-1, 1, -1], // 4
  [1, 1, -1], // 5
  [1, 1, 1], // 6
  [-1, 1, 1], // 7
];

// 12 triangles (2 per face) with outward winding. Verified against Recast: the
// top face (corners 4-7) is marked walkable; the steep side walls are not. A
// solid box with a genuine top surface is REQUIRED — a single degenerate flat
// quad rasterizes to a zero-height heightfield and yields 0 polygons.
const BOX_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 3], // bottom (y-)
  [4, 6, 5],
  [4, 7, 6], // top (y+, walkable)
  [0, 4, 5],
  [0, 5, 1], // z-
  [1, 5, 6],
  [1, 6, 2], // x+
  [2, 6, 7],
  [2, 7, 3], // z+
  [3, 7, 4],
  [3, 4, 0], // x-
];

const VERTS_PER_BOX = UNIT_BOX_CORNERS.length;
const FLOATS_PER_VERT = 3;
const INDICES_PER_BOX = BOX_FACES.length * 3;

/**
 * Build a solid axis-aligned box as a {@link TriMesh}, centered at `center`
 * with the given half-extents. Used both for the ground slab and for obstacle
 * volumes that carve holes into the navmesh.
 */
export function boxTriMesh(center: Vec3, halfExtents: Vec3): TriMesh {
  const positions = new Float32Array(VERTS_PER_BOX * FLOATS_PER_VERT);
  for (let i = 0; i < VERTS_PER_BOX; i++) {
    const corner = UNIT_BOX_CORNERS[i];
    positions[i * FLOATS_PER_VERT] = center.x + corner[0] * halfExtents.x;
    positions[i * FLOATS_PER_VERT + 1] = center.y + corner[1] * halfExtents.y;
    positions[i * FLOATS_PER_VERT + 2] = center.z + corner[2] * halfExtents.z;
  }
  const indices = new Uint32Array(INDICES_PER_BOX);
  for (let f = 0; f < BOX_FACES.length; f++) {
    const face = BOX_FACES[f];
    indices[f * 3] = face[0];
    indices[f * 3 + 1] = face[1];
    indices[f * 3 + 2] = face[2];
  }
  return { positions, indices };
}

/**
 * Concatenate several triangle meshes into one, offsetting each mesh's indices
 * so they keep pointing at their own vertices. recast-navigation builds one
 * navmesh from a single (positions, indices) pair, so the whole scene must be
 * merged first.
 */
export function mergeTriMeshes(meshes: TriMesh[]): TriMesh {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const m of meshes) {
    totalVerts += m.positions.length;
    totalIndices += m.indices.length;
  }
  const positions = new Float32Array(totalVerts);
  const indices = new Uint32Array(totalIndices);
  let vOffset = 0; // in floats
  let iOffset = 0; // in indices
  for (const m of meshes) {
    positions.set(m.positions, vOffset);
    const vertexBase = vOffset / FLOATS_PER_VERT;
    for (let i = 0; i < m.indices.length; i++) {
      indices[iOffset + i] = m.indices[i] + vertexBase;
    }
    vOffset += m.positions.length;
    iOffset += m.indices.length;
  }
  return { positions, indices };
}

/** XZ footprint of a box obstacle — the region a path must NOT intrude. */
export function boxFootprintXZ(center: Vec3, halfExtents: Vec3): AabbXZ {
  return {
    minX: center.x - halfExtents.x,
    maxX: center.x + halfExtents.x,
    minZ: center.z - halfExtents.z,
    maxZ: center.z + halfExtents.z,
  };
}

/**
 * True if `p` lies inside `aabb` on the XZ plane. A positive `margin` shrinks
 * the box inward, tolerating the small overshoot that comes from the agent
 * radius and from Recast's voxel quantization at the obstacle border.
 */
export function pointInAabbXZ(p: Vec3, aabb: AabbXZ, margin = 0): boolean {
  return (
    p.x > aabb.minX + margin &&
    p.x < aabb.maxX - margin &&
    p.z > aabb.minZ + margin &&
    p.z < aabb.maxZ - margin
  );
}
