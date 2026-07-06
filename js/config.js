const CONFIG = {
  BASE: 'https://services3.arcgis.com/dha0QtUTrPxlyZDZ/arcgis/rest/services',
  LAYERS: {
    actuaciones:  'Modelo_DGA_v2_gdb/FeatureServer/6',
    indicadores:  'Modelo_DGA_v2_gdb/FeatureServer/17',
    conservacion: 'Vista_ActConservacion_Intervenciones/FeatureServer/0',
    lineal:       'Modelo_DGA_v2_gdb/FeatureServer/1',
    mejora:       'Modelo_DGA_v2_gdb/FeatureServer/4',
  },
  STATUS_COLORS: {
    'Ejecutado':      '#1D4ED8',
    'En ejecución':   '#15803D',
    'En tramitación': '#D97706',
    'Planificado':    '#DC2626',
  },
  STATUS_BG: {
    'Ejecutado':      '#DBEAFE',
    'En ejecución':   '#DCFCE7',
    'En tramitación': '#FEF3C7',
    'Planificado':    '#FEE2E2',
  },
  CACHE_TTL: 4 * 60 * 60 * 1000, // 4 horas
};
