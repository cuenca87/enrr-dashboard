/* ── STATE ───────────────────────────────────── */
const State = {
  tab: 'rest',
  restFeatures: [],
  consFeatures: [],
  restFiltered: [],
  consFiltered: [],
  restVisible: [],
  consVisible: [],
  indRecords: [],     // registros raw de Act_Indicadores (con AÑO)
  restFilters: { dh: '', estado: '', ccaa: '', provincia: '', ano: '' },
  consFilters: { dh: '', ano: '', ccaa: '', provincia: '' },
  restSortCol: '', restSortAsc: true,
  maps: {},
  layers: {},
  charts: {},
  searchStr: { rest: '', cons: '' },
  _statsTimer: {},    // debounce timers por tab
};

/* ── UTILS ───────────────────────────────────── */
const fmt = {
  num: v => v == null ? '–' : Number(v).toLocaleString('es-ES', { maximumFractionDigits: 1 }),
  km:  v => v == null ? '–' : `${Number(v).toLocaleString('es-ES', { maximumFractionDigits: 1 })} km`,
  eur: v => v == null ? '–' : `${(Number(v)/1e6).toLocaleString('es-ES', { maximumFractionDigits: 2 })} M€`,
};

function sum(arr, field) {
  return arr.reduce((a, f) => a + (Number(f[field]) || 0), 0);
}

function statusBadge(estado) {
  const color = CONFIG.STATUS_COLORS[estado] || '#64748b';
  const bg    = CONFIG.STATUS_BG[estado]     || '#f1f5f9';
  return `<span class="badge" style="color:${color};background:${bg}">${estado || '–'}</span>`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

/* ── BBOX / VISIBILIDAD EN MAPA ──────────────── */

// Precalcula y guarda el bbox de cada feature para no recalcular en cada moveend
function precomputeBBox(features) {
  features.forEach(f => {
    f._bbox = computeBBox(f.geometry);
  });
}

function computeBBox(geom) {
  if (!geom) return null;
  let coords = [];
  if      (geom.type === 'Point')           coords = [geom.coordinates];
  else if (geom.type === 'LineString')      coords = geom.coordinates;
  else if (geom.type === 'MultiLineString') coords = geom.coordinates.flat();
  else if (geom.type === 'MultiPoint')      coords = geom.coordinates;
  else if (geom.type === 'Polygon')         coords = geom.coordinates.flat();
  else if (geom.type === 'MultiPolygon')    coords = geom.coordinates.flat(2);
  if (!coords.length) return null;
  const lngs = coords.map(c => c[0]);
  const lats  = coords.map(c => c[1]);
  return {
    w: Math.min(...lngs), e: Math.max(...lngs),
    s: Math.min(...lats), n: Math.max(...lats),
  };
}

function intersectsBounds(bbox, bounds) {
  if (!bbox) return false;
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return !(bbox.e < sw.lng || bbox.w > ne.lng ||
           bbox.n < sw.lat || bbox.s > ne.lat);
}

function featuresInBounds(features, bounds) {
  return features.filter(f => intersectsBounds(f._bbox, bounds));
}

/* ── MAPA BADGE (visible/total) ──────────────── */
function updateMapBadge(tab, visible, total) {
  const el = document.getElementById(`map-badge-${tab}`);
  if (!el) return;
  if (visible === total) {
    el.textContent = `${total} actuaciones`;
    el.style.background = '#f1f5f9';
  } else {
    el.textContent = `${visible} visible en mapa · ${total} en filtro`;
    el.style.background = '#fef9c3';
  }
}

/* ── STATS REFRESH (sobre features visibles) ─── */
function scheduleStatsUpdate(tab, delay = 180) {
  clearTimeout(State._statsTimer[tab]);
  State._statsTimer[tab] = setTimeout(() => doStatsUpdate(tab), delay);
}

function doStatsUpdate(tab) {
  const map      = State.maps[tab];
  if (!map) return;
  const filtered = tab === 'rest' ? State.restFiltered : State.consFiltered;
  let visible;
  try {
    const bounds = map.getBounds();
    visible = featuresInBounds(filtered, bounds);
  } catch (_) {
    visible = filtered; // mapa no listo todavía, usa todo
  }

  if (tab === 'rest') {
    State.restVisible = visible;
    updateMapBadge('rest', visible.length, filtered.length);
    updateRestKPIs(visible);
    buildStatusPie('chart-pie-rest', visible);
    buildDHBar('chart-dh-rest', visible);
    buildPresupBar('chart-presup-rest', visible);
    buildRestTable(visible);
  } else {
    State.consVisible = visible;
    updateMapBadge('cons', visible.length, filtered.length);
    updateConsKPIs(visible);
    buildConsTipoBar('chart-cons-tipo', visible);
    buildConsTable(visible);
  }
}

/* ── NORMALIZACIÓN DE DATOS ──────────────────── */

// Variantes incorrectas en el campo CCAA → valor canónico
const CCAA_NORM_MAP = {
  'Castilla La Mancha':                  'Castilla-La Mancha',
  'Castilla la Mancha':                  'Castilla-La Mancha',
  'Comunidad Foral del Navarra':         'Comunidad Foral de Navarra',
  'NavComunidad Foral de Navarraarra':   'Comunidad Foral de Navarra',
  'NavaComunidad Foral de Navarrarra':   'Comunidad Foral de Navarra',
  'NavarComunidad Foral de Navarrara':   'Comunidad Foral de Navarra',
  'Comunidad Valencia':                  'Comunidad Valenciana',
  'Madrid':                              'Comunidad de Madrid',
  'Vasco':                               'País Vasco',
};

// Provincias con artículo al final (formato administrativo) → forma normal
const PROV_NORM_MAP = {
  'Coruña, A':  'A Coruña',
  'Rioja, La':  'La Rioja',
  'Palmas, Las':'Las Palmas',
};

function normCCAA(raw) {
  if (!raw) return '';
  // Puede contener múltiples CCAA separadas por coma: tomar la primera
  const first = raw.split(',')[0].replace(/\.$/, '').trim();
  return CCAA_NORM_MAP[first] ?? first;
}

function normProvincia(raw) {
  if (!raw) return '';
  // Limpiar saltos de línea
  const clean = raw.split(/\r?\n/)[0].trim();
  // Caso artículo al final ("Coruña, A" / "Rioja, La")
  if (PROV_NORM_MAP[clean]) return PROV_NORM_MAP[clean];
  // Múltiples provincias separadas por coma o punto y coma → tomar la primera
  const first = clean.split(/[,;]/)[0].trim();
  return PROV_NORM_MAP[first] ?? first;
}

// Añade _ccaa y _prov normalizados a cada feature (se llama una sola vez tras cargar)
function normalizeFeatures(features) {
  features.forEach(f => {
    const p = f.properties;
    f._ccaa = normCCAA(p.CCAA);
    f._prov = normProvincia(p.PROVINCIA);
  });
}

/* ── FILTERS ─────────────────────────────────── */
function populateSelect(id, values, placeholder) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  [...new Set(values.filter(Boolean))].sort().forEach(v => {
    sel.innerHTML += `<option value="${v}">${v}</option>`;
  });
}

function buildRestFilters() {
  const feats = State.restFeatures;
  const props = feats.map(f => f.properties);
  populateSelect('rf-dh',       props.map(p => p.DH_NOM),     'Demarcación H.');
  populateSelect('rf-estado',   props.map(p => p.EST_EJEC_ACT),'Estado ejecución');
  populateSelect('rf-ccaa',     feats.map(f => f._ccaa),       'CCAA');
  populateSelect('rf-provincia',feats.map(f => f._prov),       'Provincia');
  populateSelect('rf-ano',      props.map(p => p.AÑO_INICIO).filter(v => v && v.trim() && v.length === 4), 'Año inicio');
}

function buildConsFilters() {
  const feats = State.consFeatures;
  const props = feats.map(f => f.properties);
  populateSelect('cf-dh',       props.map(p => p.DH_NOM),  'Demarcación H.');
  populateSelect('cf-ano',      props.map(p => String(p.AÑO||'')).filter(v => v && v !== 'null'), 'Año');
  populateSelect('cf-ccaa',     feats.map(f => f._ccaa),    'CCAA');
  populateSelect('cf-provincia',feats.map(f => f._prov),    'Provincia');
}

function applyRestFilters() {
  const fl = State.restFilters;
  State.restFiltered = State.restFeatures.filter(f => {
    const p = f.properties;
    if (fl.dh       && p.DH_NOM       !== fl.dh)     return false;
    if (fl.estado   && p.EST_EJEC_ACT !== fl.estado)  return false;
    if (fl.ccaa     && f._ccaa        !== fl.ccaa)    return false;
    if (fl.provincia&& f._prov        !== fl.provincia)return false;
    if (fl.ano      && p.AÑO_INICIO   !== fl.ano)     return false;
    return true;
  });
  updateRestMap(State.restFiltered);
  updateIndUI();
}

function applyConsFilters() {
  const fl = State.consFilters;
  State.consFiltered = State.consFeatures.filter(f => {
    const p = f.properties;
    if (fl.dh       && p.DH_NOM           !== fl.dh)   return false;
    if (fl.ano      && String(p.AÑO||'')  !== fl.ano)  return false;
    if (fl.ccaa     && f._ccaa            !== fl.ccaa)  return false;
    if (fl.provincia&& f._prov            !== fl.provincia) return false;
    return true;
  });
  updateConsMap(State.consFiltered);
}

/* ── KPIs ────────────────────────────────────── */
function updateRestKPIs(features) {
  const props = features.map(f => f.properties);
  // Los KPIs de indicadores solo cuentan actuaciones Ejecutadas (igual que el dashboard original)
  const inds = features
    .filter(f => f._ind && f.properties.EST_EJEC_ACT === 'Ejecutado')
    .map(f => f._ind);
  document.getElementById('kpi-nact').textContent   = fmt.num(features.length);
  document.getElementById('kpi-long').textContent   = fmt.km(sum(props, 'LONG_ACT'));
  document.getElementById('kpi-presup').textContent = fmt.eur(sum(props, 'PRESUP_ACT'));
  document.getElementById('kpi-kmrest').textContent = fmt.km(sum(inds, 'KM_RIO_REST'));
  document.getElementById('kpi-kmcon').textContent  = fmt.km(sum(inds, 'KM_RIO_CONEC'));
  document.getElementById('kpi-hab').textContent    = fmt.num(sum(inds, 'HAB_ZI'));
  document.getElementById('kpi-barr').textContent   = fmt.num(sum(inds, 'ELIM_BARR'));
}

function updateConsKPIs(features) {
  const props = features.map(f => f.properties);
  document.getElementById('kpi-cons-nact').textContent   = fmt.num(features.length);
  document.getElementById('kpi-cons-long').textContent   = fmt.km(sum(props, 'EXTRA_D2'));
  document.getElementById('kpi-cons-presup').textContent = fmt.eur(sum(props, 'PRESUP_CONS'));
}

/* ── CHARTS ──────────────────────────────────── */
function destroyChart(id) {
  if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
}

function buildStatusPie(canvasId, features) {
  destroyChart(canvasId);
  const counts = {};
  features.forEach(f => {
    const e = f.properties.EST_EJEC_ACT || 'Sin estado';
    counts[e] = (counts[e] || 0) + 1;
  });
  const labels = Object.keys(counts);
  const data   = labels.map(l => counts[l]);
  const colors = labels.map(l => CONFIG.STATUS_COLORS[l] || '#94a3b8');
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.label}: ${ctx.parsed} (${features.length ? ((ctx.parsed/features.length)*100).toFixed(1) : 0}%)`
        }},
      },
    },
  });
}

function buildDHBar(canvasId, features) {
  destroyChart(canvasId);
  const statusOrder = ['Ejecutado','En ejecución','En tramitación','Planificado'];
  const dhSet = [...new Set(features.map(f => f.properties.DH_NOM).filter(Boolean))].sort();
  const datasets = statusOrder.map(s => ({
    label: s,
    data: dhSet.map(dh => features.filter(f => f.properties.DH_NOM === dh && f.properties.EST_EJEC_ACT === s).length),
    backgroundColor: CONFIG.STATUS_COLORS[s] || '#94a3b8',
  }));
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: dhSet, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, ticks: { font: { size: 10 } } },
      },
      plugins: {
        legend: { labels: { font: { size: 10 }, boxWidth: 10 } },
        tooltip: { mode: 'index' },
      },
    },
  });
}

function buildPresupBar(canvasId, features) {
  destroyChart(canvasId);
  const statusOrder = ['Ejecutado','En ejecución','En tramitación','Planificado'];
  const dhSet = [...new Set(features.map(f => f.properties.DH_NOM).filter(Boolean))].sort();
  const datasets = statusOrder.map(s => ({
    label: s,
    data: dhSet.map(dh =>
      features
        .filter(f => f.properties.DH_NOM === dh && f.properties.EST_EJEC_ACT === s)
        .reduce((a, f) => a + (f.properties.PRESUP_ACT || 0), 0) / 1e6
    ),
    backgroundColor: CONFIG.STATUS_COLORS[s] || '#94a3b8',
  }));
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: dhSet, datasets },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 }, callback: v => `${v}M€` } },
        y: { stacked: true, ticks: { font: { size: 10 } } },
      },
      plugins: {
        legend: { labels: { font: { size: 10 }, boxWidth: 10 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.x.toFixed(2)} M€` } },
      },
    },
  });
}

function buildConsTipoBar(canvasId, features) {
  destroyChart(canvasId);
  const tipoFields = [
    { key: 'ESTABILIZACION_MARGENES', label: 'Estabilización márgenes' },
    { key: 'TRATAMIENTOS_SELVICOLAS', label: 'Tratamientos selvícolas' },
    { key: 'PLANTACIONES',            label: 'Plantaciones' },
    { key: 'ELIMINACION_OBSTACULOS',  label: 'Elim. obstáculos' },
    { key: 'RETIRADA_EEI',            label: 'Retirada EEI' },
    { key: 'ELIMINACION_TAPONES',     label: 'Elim. tapones' },
  ];
  const counts = tipoFields.map(t => ({
    label: t.label,
    count: features.filter(f => {
      const v = f.properties[t.key];
      return v && v !== 'No' && v !== '0' && v !== 'null';
    }).length,
  }));
  counts.sort((a, b) => b.count - a.count);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: counts.map(c => c.label),
      datasets: [{ data: counts.map(c => c.count), backgroundColor: '#1a56db', borderRadius: 4 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x} actuaciones` } },
      },
      scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } },
    },
  });
}

/* ── MAP ─────────────────────────────────────── */
/* Control Leaflet de opacidad del fondo */
const OpacityControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd(map) {
    const div = L.DomUtil.create('div', 'leaflet-bar opacity-ctrl');
    div.innerHTML =
      `<label class="opacity-ctrl-inner" title="Opacidad del mapa de fondo">
        🗺 <input type="range" min="10" max="100" value="100" step="5">
        <span class="opacity-pct">100%</span>
      </label>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    const slider = div.querySelector('input');
    const label  = div.querySelector('.opacity-pct');

    const applyOpacity = () => {
      const v = Number(slider.value) / 100;
      label.textContent = `${slider.value}%`;
      map.eachLayer(l => { if (l instanceof L.TileLayer) l.setOpacity(v); });
    };

    slider.addEventListener('input', applyOpacity);
    // Reaplicar cuando el usuario cambia la capa base
    map.on('baselayerchange', () => setTimeout(applyOpacity, 50));

    return div;
  },
});

function initMaps() {
  function makeTiles(url, attr) {
    return L.tileLayer(url, { attribution: attr, maxZoom: 19 });
  }
  function createMap(id) {
    const osm  = makeTiles('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap');
    const pnoa = makeTiles(
      'https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible' +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png', '© IGN PNOA'
    );
    const map = L.map(id, { layers: [osm], zoomControl: true }).setView([40.4, -3.7], 6);
    L.control.layers({ 'Mapa': osm, 'Ortofoto PNOA': pnoa }, {}, { position: 'topleft' }).addTo(map);
    new OpacityControl().addTo(map);
    return map;
  }
  State.maps.rest = createMap('map-rest');
  State.maps.cons = createMap('map-cons');
}

function attachMapListeners() {
  ['rest', 'cons'].forEach(tab => {
    State.maps[tab].on('moveend zoomend', () => scheduleStatsUpdate(tab));
  });
}

function updateRestMap(features) {
  const map = State.maps.rest;
  if (State.layers.rest) State.layers.rest.remove();
  State.layers.rest = L.geoJSON(
    { type: 'FeatureCollection', features },
    {
      style: f => {
        const color = CONFIG.STATUS_COLORS[f.properties?.EST_EJEC_ACT] || '#94a3b8';
        return { color, weight: 3, opacity: .85, fillColor: color, fillOpacity: .5 };
      },
      pointToLayer: (f, latlng) => {
        const color = CONFIG.STATUS_COLORS[f.properties.EST_EJEC_ACT] || '#94a3b8';
        return L.circleMarker(latlng, { radius: 6, color, weight: 2, fillColor: color, fillOpacity: .7 });
      },
      onEachFeature: (f, layer) => layer.bindPopup(popupRest(f)),
    }
  ).addTo(map);
  if (features.length) {
    try { map.fitBounds(State.layers.rest.getBounds(), { padding: [20, 20], maxZoom: 12 }); } catch (_) {}
  }
  // Si fitBounds no dispara moveend (sin cambio de vista), forzar actualización
  scheduleStatsUpdate('rest', 300);
}

function updateConsMap(features) {
  const map = State.maps.cons;
  if (State.layers.cons) State.layers.cons.remove();
  State.layers.cons = L.geoJSON(
    { type: 'FeatureCollection', features },
    {
      style: () => ({ color: '#1a56db', weight: 3, opacity: .8 }),
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 5, color: '#1a56db', fillColor: '#1a56db', fillOpacity: .7, weight: 2 }),
      onEachFeature: (f, layer) => layer.bindPopup(popupCons(f)),
    }
  ).addTo(map);
  if (features.length) {
    try { map.fitBounds(State.layers.cons.getBounds(), { padding: [20, 20], maxZoom: 12 }); } catch (_) {}
  }
  scheduleStatsUpdate('cons', 300);
}

function popupRest(f) {
  const p = f.properties;
  return `<div class="popup-title">${p.TITULO_ACT || p.CLAVE_ACT || 'Actuación'}</div>
    <div class="popup-row"><span class="lbl">Clave:</span><span>${p.CLAVE_ACT || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Demarcación:</span><span>${p.DH_NOM || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Cauce:</span><span>${p.CAUCE || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Estado:</span>${statusBadge(p.EST_EJEC_ACT)}</div>
    <div class="popup-row"><span class="lbl">Longitud:</span><span>${fmt.km(p.LONG_ACT)}</span></div>
    <div class="popup-row"><span class="lbl">Presupuesto:</span><span>${fmt.eur(p.PRESUP_ACT)}</span></div>
    <div class="popup-row"><span class="lbl">CCAA:</span><span>${p.CCAA || '–'}</span></div>`;
}

function popupCons(f) {
  const p = f.properties;
  return `<div class="popup-title">${p.TITULO_EXPDTE || p.CLAVE_EXPDTE_CONS || 'Conservación'}</div>
    <div class="popup-row"><span class="lbl">Clave:</span><span>${p.CLAVE_EXPDTE_CONS || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Demarcación:</span><span>${p.DH_NOM || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Cauce:</span><span>${p.CAUCE || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Estado:</span><span>${p.EST_EJEC_EXPDTE || '–'}</span></div>
    <div class="popup-row"><span class="lbl">Longitud:</span><span>${fmt.km(p.EXTRA_D2)}</span></div>
    <div class="popup-row"><span class="lbl">Presupuesto:</span><span>${fmt.eur(p.PRESUP_CONS)}</span></div>`;
}

/* ── TABLE ───────────────────────────────────── */
function buildRestTable(features) {
  const search = State.searchStr.rest.toLowerCase();
  const cols = [
    { key: 'CLAVE_ACT',    label: 'Clave' },
    { key: 'DH_NOM',       label: 'Demarcación' },
    { key: 'CCAA',         label: 'CCAA' },
    { key: 'CAUCE',        label: 'Cauce' },
    { key: 'EST_EJEC_ACT', label: 'Estado' },
    { key: 'LONG_ACT',     label: 'Long.(km)' },
    { key: 'PRESUP_ACT',   label: 'Presupuesto' },
    { key: 'FINANCIACION', label: 'Financiación' },
  ];
  let rows = features.map(f => f.properties);
  if (search) rows = rows.filter(p =>
    Object.values(p).some(v => String(v||'').toLowerCase().includes(search))
  );
  if (State.restSortCol) {
    rows.sort((a, b) => {
      const av = a[State.restSortCol] ?? '';
      const bv = b[State.restSortCol] ?? '';
      return State.restSortAsc
        ? String(av).localeCompare(String(bv), 'es', { numeric: true })
        : String(bv).localeCompare(String(av), 'es', { numeric: true });
    });
  }
  const container = document.getElementById('table-rest-body');
  const countEl   = document.getElementById('rest-count');
  if (!container) return;
  countEl.textContent = `${rows.length} actuaciones visibles`;

  const thead = `<thead><tr>${cols.map(c =>
    `<th data-col="${c.key}">${c.label}${State.restSortCol === c.key ? (State.restSortAsc ? ' ↑' : ' ↓') : ''}</th>`
  ).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(0, 500).map(p =>
    `<tr class="table-row-link" data-clave="${p.CLAVE_ACT ?? ''}">${cols.map(c => {
      if (c.key === 'EST_EJEC_ACT') return `<td>${statusBadge(p[c.key])}</td>`;
      if (c.key === 'LONG_ACT')    return `<td>${fmt.km(p[c.key])}</td>`;
      if (c.key === 'PRESUP_ACT')  return `<td>${fmt.eur(p[c.key])}</td>`;
      return `<td>${p[c.key] ?? '–'}</td>`;
    }).join('')}</tr>`
  ).join('')}</tbody>`;
  container.innerHTML = thead + tbody;

  container.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (State.restSortCol === col) State.restSortAsc = !State.restSortAsc;
      else { State.restSortCol = col; State.restSortAsc = true; }
      buildRestTable(State.restVisible.length ? State.restVisible : State.restFiltered);
    });
  });
}

function buildConsTable(features) {
  const search = State.searchStr.cons.toLowerCase();
  const cols = [
    { key: 'CLAVE_EXPDTE_CONS', label: 'Clave' },
    { key: 'DH_NOM',            label: 'Demarcación' },
    { key: 'CCAA',              label: 'CCAA' },
    { key: 'CAUCE',             label: 'Cauce' },
    { key: 'EST_EJEC_EXPDTE',   label: 'Estado' },
    { key: 'EXTRA_D2',          label: 'Long.(km)' },
    { key: 'PRESUP_CONS',       label: 'Presupuesto' },
  ];
  let rows = features.map(f => f.properties);
  if (search) rows = rows.filter(p =>
    Object.values(p).some(v => String(v||'').toLowerCase().includes(search))
  );
  const container = document.getElementById('table-cons-body');
  const countEl   = document.getElementById('cons-count');
  if (!container) return;
  countEl.textContent = `${rows.length} actuaciones visibles`;
  const thead = `<thead><tr>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.slice(0, 500).map(p =>
    `<tr>${cols.map(c => {
      if (c.key === 'EXTRA_D2')    return `<td>${fmt.km(p[c.key])}</td>`;
      if (c.key === 'PRESUP_CONS') return `<td>${fmt.eur(p[c.key])}</td>`;
      return `<td>${p[c.key] ?? '–'}</td>`;
    }).join('')}</tr>`
  ).join('')}</tbody>`;
  container.innerHTML = thead + tbody;
}

/* ── INDICADORES ─────────────────────────────── */

// Devuelve los registros de indicadores que corresponden a las actuaciones filtradas
function getFilteredIndicadores() {
  const claveSet = new Set(State.restFiltered.map(f => f.properties.CLAVE_ACT));
  return State.indRecords.filter(r => claveSet.has(r.attributes.CLAVE_ACT));
}

// Agrupa registros de indicadores por año y acumula campos numéricos
function aggregateByYear(records) {
  const FIELDS = ['KM_RIO_REST','KM_RIO_CONEC','KM_CAU_ANT','HAB_ZI',
                  'ELIM_BARR','ADAPT_BARR','KM_ELIM_LONG','KM_RETR_LONG',
                  'KM_VEG_RIB','KM_ELIM_EEI','PRESUP_ACT'];
  const byYear = {};
  records.forEach(r => {
    const year = r.attributes.AÑO;
    if (!year || year < 2000 || year > 2030) return;
    if (!byYear[year]) {
      byYear[year] = {};
      FIELDS.forEach(f => byYear[year][f] = 0);
    }
    FIELDS.forEach(f => { byYear[year][f] += Number(r.attributes[f]) || 0; });
  });
  return byYear;
}

function updateIndKPIs(records) {
  const ejecutadoClaves = new Set(
    State.restFiltered
      .filter(f => f.properties.EST_EJEC_ACT === 'Ejecutado')
      .map(f => f.properties.CLAVE_ACT)
  );
  const inds = records.filter(r => ejecutadoClaves.has(r.attributes.CLAVE_ACT)).map(r => r.attributes);
  document.getElementById('kpi-ind-nact').textContent   = fmt.num(State.restFiltered.length);
  document.getElementById('kpi-ind-kmrest').textContent = fmt.km(sum(inds, 'KM_RIO_REST'));
  document.getElementById('kpi-ind-kmcon').textContent  = fmt.km(sum(inds, 'KM_RIO_CONEC'));
  document.getElementById('kpi-ind-barr').textContent   = fmt.num(sum(inds, 'ELIM_BARR'));
  document.getElementById('kpi-ind-veg').textContent    = fmt.km(sum(inds, 'KM_VEG_RIB'));
  document.getElementById('kpi-ind-hab').textContent    = fmt.num(sum(inds, 'HAB_ZI'));
  document.getElementById('kpi-ind-presup').textContent = fmt.eur(sum(State.restFiltered.map(f => f.properties), 'PRESUP_ACT'));
}

function buildIndYearBar(canvasId, actuaciones) {
  destroyChart(canvasId);
  const statusOrder = ['Ejecutado','En ejecución','En tramitación','Planificado'];
  const yearSet = [...new Set(
    actuaciones.map(f => f.properties.AÑO_INICIO).filter(v => v && v.trim() && v.length === 4)
  )].sort();
  const datasets = statusOrder.map(s => ({
    label: s,
    data: yearSet.map(y => actuaciones.filter(f =>
      f.properties.AÑO_INICIO === y && f.properties.EST_EJEC_ACT === s
    ).length),
    backgroundColor: CONFIG.STATUS_COLORS[s] || '#94a3b8',
  }));
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: yearSet, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { font: { size: 10 } } },
        y: { stacked: true, ticks: { font: { size: 10 } } },
      },
      plugins: {
        legend: { labels: { font: { size: 10 }, boxWidth: 10 } },
        tooltip: { mode: 'index' },
      },
    },
  });
}

function buildIndTimeBar(canvasId, byYear, seriesDef) {
  destroyChart(canvasId);
  const years = Object.keys(byYear).map(Number).sort();
  const datasets = seriesDef.map(s => ({
    label: s.label,
    data: years.map(y => byYear[y]?.[s.field] || 0),
    backgroundColor: s.color,
    borderRadius: 3,
  }));
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  State.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels: years, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { ticks: { font: { size: 10 }, callback: v => s => v } },
      },
      plugins: {
        legend: { labels: { font: { size: 10 }, boxWidth: 10 } },
        tooltip: { mode: 'index' },
      },
    },
  });
}

function updateIndUI() {
  const indFiltered = getFilteredIndicadores();
  const byYear      = aggregateByYear(indFiltered);

  updateIndKPIs(indFiltered);

  // Actuaciones por año (desde restFiltered, no indicadores)
  buildIndYearBar('chart-ind-year', State.restFiltered);

  // km ríos por año
  buildIndTimeBar('chart-ind-rios', byYear, [
    { field: 'KM_RIO_REST',  label: 'Río restaurado (km)',  color: '#1D4ED8' },
    { field: 'KM_RIO_CONEC', label: 'Río conectado (km)',   color: '#15803D' },
    { field: 'KM_CAU_ANT',   label: 'Cauce anterior (km)',  color: '#9333EA' },
  ]);

  // Habitantes protegidos por año
  buildIndTimeBar('chart-ind-hab', byYear, [
    { field: 'HAB_ZI', label: 'Habitantes protegidos', color: '#D97706' },
  ]);

  // Barreras transversales por año
  buildIndTimeBar('chart-ind-barr', byYear, [
    { field: 'ELIM_BARR',   label: 'Barreras eliminadas',  color: '#DC2626' },
    { field: 'ADAPT_BARR',  label: 'Barreras adaptadas',   color: '#FB923C' },
  ]);

  // Vegetación ribereña y EEI
  buildIndTimeBar('chart-ind-veg', byYear, [
    { field: 'KM_VEG_RIB',   label: 'Veg. ribereña (km)',   color: '#16A34A' },
    { field: 'KM_ELIM_EEI',  label: 'Elim. EEI (km)',       color: '#86EFAC' },
  ]);
}

/* ── TABS ────────────────────────────────────── */
function switchTab(tab) {
  State.tab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));

  // Mostrar los controles de filtro correctos
  document.getElementById('filters-rest').style.display = (tab === 'rest' || tab === 'ind') ? 'flex' : 'none';
  document.getElementById('filters-cons').style.display = tab === 'cons' ? 'flex' : 'none';

  if (State.maps[tab]) {
    setTimeout(() => {
      State.maps[tab].invalidateSize();
      // Re-aplicar bounds: el fitBounds inicial se hizo con el contenedor oculto
      const layer = State.layers[tab];
      if (layer) {
        try {
          const bounds = layer.getBounds();
          if (bounds.isValid()) {
            State.maps[tab].fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
          }
        } catch (_) {}
      }
      scheduleStatsUpdate(tab, 300);
    }, 120);
  }
}

/* ── INIT ────────────────────────────────────── */
async function init() {
  const overlay = document.getElementById('loading-overlay');
  const loadMsg = document.getElementById('loading-msg');
  try {
    overlay.classList.remove('hidden');
    loadMsg.textContent = 'Cargando datos de restauración fluvial…';
    State.restFeatures = await Data.loadRestauracion();

    loadMsg.textContent = 'Cargando datos de conservación de cauces…';
    State.consFeatures  = await Data.loadConservacion();

    // Precalcular bboxes para consultas de visibilidad rápidas
    precomputeBBox(State.restFeatures);
    precomputeBBox(State.consFeatures);

    State.restFiltered = [...State.restFeatures];
    State.consFiltered = [...State.consFeatures];

    State.indRecords = Data.getIndicadores();

    // Normalizar CCAA y PROVINCIA (datos con errores en origen)
    normalizeFeatures(State.restFeatures);
    normalizeFeatures(State.consFeatures);

    overlay.classList.add('hidden');

    initMaps();
    attachMapListeners();
    buildRestFilters();
    buildConsFilters();

    updateRestMap(State.restFiltered);
    updateConsMap(State.consFiltered);
    updateIndUI();

    switchTab('rest');
    attachEvents();
  } catch (err) {
    overlay.classList.add('hidden');
    console.error(err);
    showToast('Error al cargar datos. Verifica la conexión.');
  }
}

/* ── EVENTS ──────────────────────────────────── */
function attachEvents() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  document.getElementById('btn-filters').addEventListener('click', () => {
    document.getElementById('filter-panel').classList.toggle('collapsed');
  });

  ['rf-dh','rf-estado','rf-ccaa','rf-provincia','rf-ano'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => {
      const map = { 'rf-dh': 'dh', 'rf-estado': 'estado', 'rf-ccaa': 'ccaa', 'rf-provincia': 'provincia', 'rf-ano': 'ano' };
      State.restFilters[map[id]] = e.target.value;
      applyRestFilters();
    });
  });

  ['cf-dh','cf-ano','cf-ccaa','cf-provincia'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => {
      const map = { 'cf-dh': 'dh', 'cf-ano': 'ano', 'cf-ccaa': 'ccaa', 'cf-provincia': 'provincia' };
      State.consFilters[map[id]] = e.target.value;
      applyConsFilters();
    });
  });

  document.getElementById('btn-clear-filters')?.addEventListener('click', () => {
    State.restFilters = { dh: '', estado: '', ccaa: '', provincia: '', ano: '' };
    State.consFilters = { dh: '', ano: '', ccaa: '', provincia: '' };
    document.querySelectorAll('#filter-panel select').forEach(s => s.value = '');
    applyRestFilters();   // incluye updateIndUI()
    applyConsFilters();
    showToast('Filtros eliminados');
  });

  // Clic en fila → zoom al elemento en el mapa
  document.getElementById('table-rest-body')?.addEventListener('click', e => {
    const row = e.target.closest('tr.table-row-link');
    if (!row) return;
    const clave = row.dataset.clave;
    if (!clave) return;

    // Resaltar fila seleccionada
    document.querySelectorAll('#table-rest-body tr.table-row-link').forEach(r => r.classList.remove('row-selected'));
    row.classList.add('row-selected');

    // Buscar la capa Leaflet por CLAVE_ACT y hacer zoom
    const map = State.maps.rest;
    State.layers.rest?.eachLayer(layer => {
      if (layer.feature?.properties?.CLAVE_ACT !== clave) return;
      try {
        if (layer.getBounds) {
          map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 16 });
        } else if (layer.getLatLng) {
          map.setView(layer.getLatLng(), 15);
        }
        layer.openPopup();
      } catch (_) {}
    });
  });

  document.getElementById('search-rest')?.addEventListener('input', e => {
    State.searchStr.rest = e.target.value;
    buildRestTable(State.restVisible.length ? State.restVisible : State.restFiltered);
  });
  document.getElementById('search-cons')?.addEventListener('input', e => {
    State.searchStr.cons = e.target.value;
    buildConsTable(State.consVisible.length ? State.consVisible : State.consFiltered);
  });

  document.querySelectorAll('.chart-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.chart-card');
      group.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
      group.querySelectorAll('.chart-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      group.querySelector(`#${btn.dataset.panel}`)?.classList.add('active');
    });
  });

  document.getElementById('btn-reload')?.addEventListener('click', () => {
    Data.clearCache();
    showToast('Recargando datos…');
    setTimeout(() => location.reload(), 800);
  });
}

document.addEventListener('DOMContentLoaded', init);
