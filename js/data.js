const Data = (() => {
  let _rawIndicadores = [];
  async function fetchAll(url, outFields = '*') {
    const results = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const params = new URLSearchParams({
        where: '1=1', outFields, f: 'json',
        resultOffset: offset, resultRecordCount: pageSize,
        returnGeometry: false,
      });
      const res = await fetch(`${url}/query?${params}`);
      const json = await res.json();
      const records = json.features || [];
      results.push(...records);
      if (records.length < pageSize || json.exceededTransferLimit === false) break;
      offset += pageSize;
    }
    return results;
  }

  async function fetchGeoJSON(url) {
    const results = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const params = new URLSearchParams({
        where: '1=1', outFields: '*', f: 'geojson',
        resultOffset: offset, resultRecordCount: pageSize,
        returnGeometry: true, outSR: 4326,
      });
      const res = await fetch(`${url}/query?${params}`);
      const json = await res.json();
      const features = json.features || [];
      results.push(...features);
      if (features.length < pageSize) break;
      offset += pageSize;
    }
    return results;
  }

  function cacheKey(name) { return `enrr_${name}`; }

  function saveCache(name, data) {
    try {
      localStorage.setItem(cacheKey(name), JSON.stringify({ ts: Date.now(), data }));
    } catch (_) {}
  }

  function loadCache(name) {
    try {
      const raw = localStorage.getItem(cacheKey(name));
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > CONFIG.CACHE_TTL) return null;
      return data;
    } catch (_) { return null; }
  }

  async function get(name, url, geo = false) {
    const cached = loadCache(name);
    if (cached) return cached;
    const data = geo ? await fetchGeoJSON(url) : await fetchAll(url);
    saveCache(name, data);
    return data;
  }

  const base = CONFIG.BASE;
  return {
    async loadRestauracion() {
      const [actuaciones, indicadores] = await Promise.all([
        get('actuaciones', `${base}/${CONFIG.LAYERS.actuaciones}`, true),
        get('indicadores', `${base}/${CONFIG.LAYERS.indicadores}`, false),
      ]);
      // Join indicadores into actuaciones by CLAVE_ACT — keep only the most recent year's record
      const indMap = {};
      indicadores.forEach(f => {
        const key = f.attributes.CLAVE_ACT;
        if (!indMap[key] || (f.attributes.AÑO ?? 0) > (indMap[key].AÑO ?? 0)) {
          indMap[key] = f.attributes;
        }
      });
      _rawIndicadores = indicadores;
      actuaciones.forEach(f => {
        f._ind = indMap[f.properties.CLAVE_ACT] || null;
      });
      return actuaciones;
    },
    async loadConservacion() {
      return get('conservacion', `${base}/${CONFIG.LAYERS.conservacion}`, true);
    },
    getIndicadores() { return _rawIndicadores; },
    clearCache() {
      ['actuaciones','indicadores','conservacion'].forEach(k => {
        localStorage.removeItem(cacheKey(k));
      });
    },
  };
})();
