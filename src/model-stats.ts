import { InstancedMesh, Mesh, Object3D, Scene } from 'three';

const UNNAMED = '(unnamed)';

export interface EntityPolygonRow {
    entity: string;
    meshes: number;
    instances: number;
    triangles: number;
}

// Unique geometry per entity type: each mesh's triangles are counted once, and an InstancedMesh
// is multiplied by its instance count. Shadow passes are deliberately not multiplied here; that
// is what the render audit is for.
export function collectEntityPolygons(scene: Scene): EntityPolygonRow[] {
    const rows = new Map<string, EntityPolygonRow>();

    scene.traverse((object) => {
        if (!(object instanceof Mesh) || object.name === 'shadow-proxy') {
            return;
        }

        const key = `${nearestNamedOwner(object, scene)} / ${baseName(object.name)}`;
        let row = rows.get(key);
        if (!row) {
            row = { entity: key, meshes: 0, instances: 0, triangles: 0 };
            rows.set(key, row);
        }

        const instances = object instanceof InstancedMesh ? object.count : 1;
        row.meshes++;
        row.instances += instances;
        row.triangles += triangleCount(object) * instances;
    });

    return [...rows.values()].sort((a, b) => b.triangles - a.triangles);
}

function triangleCount(mesh: Mesh): number {
    const geometry = mesh.geometry;
    const elements = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
    return elements / 3;
}

function nearestNamedOwner(object: Object3D, scene: Scene): string {
    let node = object.parent;
    while (node && node !== scene) {
        if (node.name) {
            return node.name;
        }
        node = node.parent;
    }
    return 'scene';
}

// Collapse per-cell instanced meshes and negative cell coordinates into one entity row.
function baseName(name: string): string {
    if (!name) {
        return UNNAMED;
    }
    return name
        .replace(/-cell--?\d+--?\d+$/, '')
        .replace(/--?\d+--?\d+$/, '');
}
