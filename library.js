/* ============================================================================
 * library.js — named structure library persisted to localStorage.
 *
 * Each entry: { id, name, prompt, params, tilesetVersion, seed,
 *               connectionPoints, thumbnail (dataURL), createdAt }
 * The voxel grid itself is NOT stored: generation is deterministic, so
 * (params + seed + tilesetVersion) fully reproduces the structure.
 * connectionPoints are generic portals
 * ({ x, y, z, dir, kind: 'opening'|'potential' }) for the Phase 2 composer —
 * deliberately domain-agnostic: a door, a cave mouth, and a bridge endpoint
 * are all just labeled volumes with connection points.
 * ========================================================================== */

const STORAGE_KEY = 'voxel-architect.library.v1';

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('[library] failed to read localStorage:', e);
    return [];
  }
}

export class Library {
  constructor() {
    this.items = loadAll();
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
    } catch (e) {
      console.warn('[library] failed to write localStorage (quota?):', e);
    }
  }

  add(entry) {
    const item = {
      id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      createdAt: new Date().toISOString(),
      ...entry,
    };
    this.items.unshift(item);
    this.save();
    return item;
  }

  get(id) {
    return this.items.find((i) => i.id === id) || null;
  }

  rename(id, name) {
    const item = this.get(id);
    if (item && name.trim()) {
      item.name = name.trim();
      this.save();
    }
    return item;
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
  }

  /**
   * Render the library list into `container`.
   * onSelect(item)  — load the structure into the viewport
   */
  renderList(container, onSelect) {
    container.innerHTML = '';
    if (this.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lib-empty';
      empty.textContent = 'Nothing saved yet. Generate something you like and hit "Save to library".';
      container.appendChild(empty);
      return;
    }
    for (const item of this.items) {
      const card = document.createElement('div');
      card.className = 'lib-card';

      const img = document.createElement('img');
      img.src = item.thumbnail || '';
      img.alt = item.name;
      card.appendChild(img);

      const meta = document.createElement('div');
      meta.className = 'lib-meta';
      const name = document.createElement('div');
      name.className = 'lib-name';
      name.textContent = item.name;
      name.title = item.prompt || '';
      const sub = document.createElement('div');
      sub.className = 'lib-sub';
      const d = new Date(item.createdAt);
      sub.textContent = `${item.params.width}×${item.params.depth} · ${item.params.stories}F · ${item.params.roofStyle} · ${d.toLocaleDateString()}`;
      meta.appendChild(name);
      meta.appendChild(sub);
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'mini';
      renameBtn.textContent = '✏️';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = prompt('Rename structure:', item.name);
        if (next && next.trim()) {
          this.rename(item.id, next);
          this.renderList(container, onSelect);
        }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'mini danger';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${item.name}" from the library?`)) {
          this.remove(item.id);
          this.renderList(container, onSelect);
        }
      });

      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);

      card.addEventListener('click', () => onSelect(item));
      container.appendChild(card);
    }
  }
}
