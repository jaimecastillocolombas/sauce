function esc(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── UTILIDADES UI ────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function mostrarToast(mensaje, tipo = 'info', duracion = 3500) {
  document.getElementById('app-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'app-toast';
  el.className = `app-toast app-toast-${tipo}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = mensaje;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  const hide = () => {
    el.classList.remove('visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  };
  if (duracion > 0) setTimeout(hide, duracion);
}

function mostrarConfirm(mensaje, { textoOk = 'Aceptar', textoCancel = 'Cancelar', peligro = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="confirm-box">
        <p class="confirm-mensaje"></p>
        <div class="confirm-botones">
          <button class="confirm-btn-cancel">${esc(textoCancel)}</button>
          <button class="confirm-btn-ok${peligro ? ' peligro' : ''}">${esc(textoOk)}</button>
        </div>
      </div>`;
    overlay.querySelector('.confirm-mensaje').textContent = mensaje;
    document.body.appendChild(overlay);
    const btnOk = overlay.querySelector('.confirm-btn-ok');
    const btnCancel = overlay.querySelector('.confirm-btn-cancel');
    const cerrar = v => { overlay.remove(); resolve(v); };
    btnOk.addEventListener('click', () => cerrar(true));
    btnCancel.addEventListener('click', () => cerrar(false));
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') cerrar(false);
      if (e.key === 'Tab') {
        const els = [btnCancel, btnOk];
        const idx = els.indexOf(document.activeElement);
        e.preventDefault();
        els[(idx + (e.shiftKey ? -1 : 1) + els.length) % els.length].focus();
      }
    });
    btnOk.focus();
  });
}

function mostrarPrompt(etiqueta, valorInicial = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="confirm-box">
        <p class="confirm-mensaje"></p>
        <input class="confirm-input" type="text" value="">
        <div class="confirm-botones">
          <button class="confirm-btn-cancel">Cancelar</button>
          <button class="confirm-btn-ok">Guardar</button>
        </div>
      </div>`;
    overlay.querySelector('.confirm-mensaje').textContent = etiqueta;
    const input = overlay.querySelector('.confirm-input');
    input.value = valorInicial;
    document.body.appendChild(overlay);
    const btnOk = overlay.querySelector('.confirm-btn-ok');
    const btnCancel = overlay.querySelector('.confirm-btn-cancel');
    const cerrar = v => { overlay.remove(); resolve(v); };
    btnOk.addEventListener('click', () => cerrar(input.value));
    btnCancel.addEventListener('click', () => cerrar(null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') cerrar(input.value); });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(null); });
    input.focus();
    input.select();
  });
}

// Focus trap para modales: devuelve función de limpieza
function crearFocusTrap(container) {
  const sel = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handler(e) {
    if (e.key !== 'Tab') return;
    const els = Array.from(container.querySelectorAll(sel)).filter(el => el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
    else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

let _focusTrapCleanup = null;
let _elementoQueAbrioModal = null;

function cargarJSON(clave, fallback) {
  try {
    const raw = localStorage.getItem(clave);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed !== null ? parsed : fallback;
  } catch (e) {
    console.error(`Error al cargar ${clave} del localStorage:`, e);
    return fallback;
  }
}

let pacientes = cargarJSON('pacientes', []);
let pacienteEditandoId = null;
let vistaActual = 'dia';
let evolucionesAñadidas = [];
let itemsTratamiento = cargarJSON('itemsTratamiento', []);
let farmacos = cargarJSON('farmacos', []); // catálogo global: [{ nombre, comprimidosPorCaja }]
let medicacionesEnModal = [];  // medicaciones del paciente que se está editando en el modal
let medicacionEditandoIdx = null; // índice dentro de medicacionesEnModal que se está editando, o null si es nueva
let modalModificado = false;
let ordenActual = 'nombre';

// Fechas de navegación
let fechaDia = new Date();
let fechaSemana = new Date();
let fechaMes = new Date();
let diaSeleccionadoMes = null;

const DIAS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// ─── INDEXEDDB PARA MEDIA ─────────────────────────────────────────────────────
let db = null;
const urlCache = new Map();    // idbKey → objectURL (persiste entre aperturas de modal)
const pendingBlobs = new WeakMap(); // wrapper DOM → Blob (nueva media sin guardar)
let fotoPendienteBlob = null;  // Blob de la nueva foto de perfil
let modalSession = 0;          // Contador para cancelar callbacks async de modales anteriores

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sauce-media', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('media', { keyPath: 'key' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(); };
    req.onerror = e => reject(e.target.error);
  });
}

function dbPut(key, blob) {
  if (!db) return Promise.resolve();
  // Convertir a ArrayBuffer antes de guardar — iOS Safari no permite
  // almacenar Blob directamente en IndexedDB
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Error leyendo archivo'));
    reader.onload = e => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').put({ key, buffer: e.target.result, type: blob.type });
      tx.oncomplete = resolve;
      tx.onerror = ev => reject(ev.target.error);
    };
    reader.readAsArrayBuffer(blob);
  });
}

function dbGet(key) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readonly');
    const req = tx.objectStore('media').get(key);
    req.onsuccess = e => {
      const record = e.target.result;
      if (!record) { resolve(null); return; }
      // Soporte formato antiguo (blob directo) y nuevo (ArrayBuffer)
      if (record.blob) { resolve(record.blob); return; }
      resolve(new Blob([record.buffer], { type: record.type || 'application/octet-stream' }));
    };
    req.onerror = e => reject(e.target.error);
  });
}

function dbDelete(key) {
  if (!db) return Promise.resolve();
  // Revocar object URL cacheada antes de eliminar de IndexedDB
  if (urlCache.has(key)) {
    const old = urlCache.get(key);
    if (old) URL.revokeObjectURL(old);
    urlCache.delete(key);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

// Devuelve una URL utilizable para mostrar una referencia de media
// ref puede ser 'idb:CLAVE' (IndexedDB) o 'data:...' (legacy base64)
async function resolverURL(ref) {
  if (!ref) return '';
  if (ref.startsWith('data:')) return ref; // base64 legacy (antes de migrar)
  if (!ref.startsWith('idb:')) return '';
  const key = ref.slice(4);
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = await dbGet(key);
  if (!blob) { urlCache.set(key, ''); return ''; }
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

function dataURLaBlob(dataURL) {
  const [header, data] = dataURL.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function blobADataURL(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(blob);
  });
}

// ─── COMPRESIÓN DE IMÁGENES ───────────────────────────────────────────────────
// Reduce imágenes a máximo 1200px y calidad 80% → ~80-150 KB por foto
function comprimirImagen(file, maxPx = 1200, calidad = 0.80) {
  return new Promise(resolve => {
    // Si file.type está vacío (ocurre en algunos iPhones), usar image/jpeg como tipo seguro
    const fallback = () => resolve(file.slice(0, file.size, file.type || 'image/jpeg'));
    const reader = new FileReader();
    reader.onerror = fallback;
    reader.onload = e => {
      const img = new Image();
      img.onerror = fallback; // archivo corrupto o formato no soportado
      img.onload = () => {
        try {
          const ratio = Math.min(maxPx / Math.max(img.width, img.height), 1);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          const ctx = canvas.getContext('2d');
          if (!ctx) { fallback(); return; } // iOS puede devolver null bajo presión de memoria
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // Validar también que el blob tenga contenido real (toBlob puede devolver blob vacío)
          canvas.toBlob(blob => (blob && blob.size > 1000) ? resolve(blob) : fallback(), 'image/jpeg', calidad);
        } catch (err) {
          fallback();
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─── MIGRACIÓN BASE64 → INDEXEDDB ─────────────────────────────────────────────
// Convierte fotos/imágenes/vídeos guardados en base64 (versión antigua) a IndexedDB
async function migrarAIndexedDB() {
  let migrado = false;
  for (const p of pacientes) {
    if (p.foto?.startsWith('data:')) {
      const key = `foto_${p.id}`;
      await dbPut(key, dataURLaBlob(p.foto));
      p.foto = `idb:${key}`;
      migrado = true;
    }
    if (p.imagenes) {
      for (let i = 0; i < p.imagenes.length; i++) {
        if (p.imagenes[i]?.startsWith('data:')) {
          const key = `img_${p.id}_${i}`;
          await dbPut(key, dataURLaBlob(p.imagenes[i]));
          p.imagenes[i] = `idb:${key}`;
          migrado = true;
        }
      }
    }
    if (p.videos) {
      for (let i = 0; i < p.videos.length; i++) {
        if (p.videos[i]?.startsWith('data:')) {
          const key = `vid_${p.id}_${i}`;
          await dbPut(key, dataURLaBlob(p.videos[i]));
          p.videos[i] = `idb:${key}`;
          migrado = true;
        }
      }
    }
  }
  if (migrado) guardarDatos();
}

function guardarDatos() {
  try {
    localStorage.setItem('pacientes', JSON.stringify(pacientes));
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      mostrarToast('❌ Almacenamiento lleno. Haz una copia de seguridad y elimina pacientes antiguos.', 'error', 6000);
      return false;
    }
    throw e;
  }
  return true;
}

function guardarItems() {
  localStorage.setItem('itemsTratamiento', JSON.stringify(itemsTratamiento));
}

function guardarFarmacos() {
  localStorage.setItem('farmacos', JSON.stringify(farmacos));
}

function toISO(date) {
  return date.toISOString().split('T')[0];
}

function fechaHoy() {
  return toISO(new Date());
}

function calcularEdad(fecha) {
  if (!fecha) return '';
  const hoy = new Date();
  const nac = new Date(fecha);
  let edad = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return `${edad} años`;
}

function formatearFecha(fecha) {
  if (!fecha) return '';
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y}`;
}

function formatearFechaCompleta(fecha) {
  if (!fecha) return '';
  const [y, m, d] = fecha.split('-');
  const date = new Date(y, m - 1, d);
  const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  return `${diasSemana[date.getDay()]} ${d}/${m}/${y}`;
}

// ─── CÁLCULO DE MEDICACIÓN ─────────────────────────────────────────────────────
// Nº de días entre dos fechas ISO, ambos extremos incluidos (mínimo 0 si el rango es inválido)
function diasEntre(inicioISO, finISO) {
  if (!inicioISO || !finISO) return 0;
  const a = new Date(inicioISO + 'T00:00:00');
  const b = new Date(finISO + 'T00:00:00');
  const dias = Math.round((b - a) / 86400000) + 1;
  return dias > 0 ? dias : 0;
}

// Fecha de fin efectiva de una medicación: si autoFin está activo, sigue la
// fecha de revisión indicada (agenda); si no, usa la fecha manual guardada en la medicación.
function resolverFinMedicacion(med, fechaRevisionRef) {
  return med.autoFin ? (fechaRevisionRef || '') : (med.fechaFin || '');
}

// Busca en el catálogo la ficha de un fármaco (comparación sin mayúsculas)
function buscarFarmacoCatalogo(nombre) {
  if (!nombre) return null;
  return farmacos.find(f => f.nombre.toLowerCase() === nombre.toLowerCase()) || null;
}

// Unidades por caja del catálogo, con compatibilidad hacia atrás con el nombre de campo antiguo
function unidadesPorCajaCatalogo(catalogo) {
  if (!catalogo) return 0;
  const valor = catalogo.unidadesPorCaja ?? catalogo.comprimidosPorCaja ?? 0;
  return parseFloat(valor) || 0;
}

// Nombre de la unidad de compra de un fármaco (comprimidos, cápsulas, ml...), con valor por defecto
function unidadLabelFarmaco(nombreFarmaco) {
  const catalogo = buscarFarmacoCatalogo(nombreFarmaco);
  return (catalogo?.unidadLabel || '').trim() || 'comprimidos';
}

// Las UNIDADES (comprimidos/cápsulas/ml) que se toman cada vez son el dato que de verdad determina
// el consumo — los mg son solo una referencia clínica que ayuda a rellenar este campo, pero el que
// manda en el cálculo es siempre 'unidadesPorToma'. Las medicaciones guardadas antes de que existiera
// este campo no lo tienen: se asume 1 unidad por toma, igual que se calculaba entonces.
function unidadesPorTomaResueltas(med) {
  if (med.unidadesPorToma === undefined || med.unidadesPorToma === '') return 1;
  const valor = parseFloat(med.unidadesPorToma);
  return (isNaN(valor) || valor < 0) ? null : valor;
}

// Total de unidades (comprimidos/cápsulas/ml) de una medicación completa, desde fechaInicio hasta su fin resuelto
function comprimidosTotalesMedicacion(med, fechaRevisionRef) {
  const fin = resolverFinMedicacion(med, fechaRevisionRef);
  if (!med.fechaInicio || !fin) return null;
  const dias = diasEntre(med.fechaInicio, fin);
  if (dias <= 0) return 0;
  const porToma = unidadesPorTomaResueltas(med);
  if (porToma === null) return null;
  return Math.ceil(dias * porToma * (parseFloat(med.frecuencia) || 0));
}

// Unidades que corresponden a una medicación solo dentro de un rango [desde, hasta]
// (usado en el resumen de consumo: un tratamiento puede empezar/acabar fuera del rango elegido)
function comprimidosEnRango(med, fechaRevisionRef, desde, hasta) {
  const fin = resolverFinMedicacion(med, fechaRevisionRef);
  if (!med.fechaInicio || !fin) return 0;
  const inicioEfectivo = med.fechaInicio > desde ? med.fechaInicio : desde;
  const finEfectivo = fin < hasta ? fin : hasta;
  const dias = diasEntre(inicioEfectivo, finEfectivo);
  if (dias <= 0) return 0;
  const porToma = unidadesPorTomaResueltas(med);
  if (porToma === null) return 0;
  return Math.ceil(dias * porToma * (parseFloat(med.frecuencia) || 0));
}

// Cajas necesarias para un nº de unidades, según el catálogo (null si no hay dato de caja)
function cajasNecesarias(nombreFarmaco, totalUnidades) {
  if (totalUnidades === null || totalUnidades === undefined) return null;
  const catalogo = buscarFarmacoCatalogo(nombreFarmaco);
  const porCaja = unidadesPorCajaCatalogo(catalogo);
  if (!(porCaja > 0)) return null;
  return Math.ceil(totalUnidades / porCaja);
}

function obtenerGenero() {
  return document.getElementById('selector-genero').value;
}

function establecerGenero(valor) {
  document.getElementById('selector-genero').value = valor || '';
}

function iniciales(nombre, apellidos) {
  return ((nombre?.[0] || '') + (apellidos?.[0] || '')).toUpperCase();
}

function badgeInfo(revision) {
  const hoy = fechaHoy();
  if (revision < hoy) return { clase: 'badge-rojo', texto: '🔴 Vencida', cardClase: 'vencida' };
  if (revision === hoy) return { clase: 'badge-naranja', texto: '🟡 Hoy', cardClase: 'hoy' };
  return { clase: 'badge-verde', texto: '🟢 Próxima', cardClase: '' };
}

function obtenerPacientesOrdenados(lista) {
  const copia = [...lista];
  if (ordenActual === 'nombre') {
    return copia.sort((a, b) => (`${a.nombre} ${a.apellidos}`).localeCompare(`${b.nombre} ${b.apellidos}`));
  } else if (ordenActual === 'cita') {
    const hoy = fechaHoy();
    return copia.sort((a, b) => {
      if (!a.revision && !b.revision) return 0;
      if (!a.revision) return 1;
      if (!b.revision) return -1;
      const aFutura = a.revision >= hoy;
      const bFutura = b.revision >= hoy;
      if (aFutura && !bFutura) return -1;
      if (!aFutura && bFutura) return 1;
      return a.revision.localeCompare(b.revision);
    });
  }
  // 'reciente': más nuevo primero
  return copia.sort((a, b) => b.id - a.id);
}

function filtrarYMostrar() {
  const texto = document.getElementById('buscador').value.toLowerCase().trim();
  let lista = texto
    ? pacientes.filter(p =>
        p.nombre.toLowerCase().includes(texto) ||
        p.apellidos.toLowerCase().includes(texto) ||
        p.id.toString().includes(texto))
    : [...pacientes];
  mostrarPacientes(obtenerPacientesOrdenados(lista));
}

function citasEnFecha(fecha) {
  return pacientes
    .filter(p => p.revision === fecha)
    .sort((a, b) => (a.horaRevision || '99:99').localeCompare(b.horaRevision || '99:99'));
}

// ─── HELPERS UI ───────────────────────────────────────────────────────────────
function abrirModalMedia(src, tipo) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px;';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(255,255,255,0.15);color:white;border:2px solid rgba(255,255,255,0.5);border-radius:50%;width:44px;height:44px;font-size:18px;cursor:pointer;z-index:1001;display:flex;align-items:center;justify-content:center;';

  if (tipo === 'imagen') {
    const img = document.createElement('img');
    img.src = src;
    img.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;cursor:pointer;';
    const cerrar = () => overlay.remove();
    overlay.appendChild(img);
    overlay.appendChild(closeBtn);
    overlay.addEventListener('click', cerrar);
    closeBtn.addEventListener('click', e => { e.stopPropagation(); cerrar(); });
  } else {
    const video = document.createElement('video');
    video.src = src;
    video.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px;';
    video.controls = true;
    video.autoplay = true;
    const cerrar = () => { video.src = ''; overlay.remove(); };
    overlay.appendChild(video);
    overlay.appendChild(closeBtn);
    overlay.addEventListener('click', cerrar);
    closeBtn.addEventListener('click', e => { e.stopPropagation(); cerrar(); });
  }
  document.body.appendChild(overlay);
}

// idbRef: referencia 'idb:CLAVE' si ya existe en IndexedDB, null si es nueva
function crearWrapperImagen(src, idbRef = null) {
  const wrapper = document.createElement('div');
  wrapper.className = 'img-wrapper';
  if (idbRef) wrapper.dataset.ref = idbRef;
  const img = document.createElement('img');
  img.src = src;
  img.className = 'img-prueba';
  img.addEventListener('click', () => abrirModalMedia(src, 'imagen'));
  const btn = document.createElement('button');
  btn.className = 'btn-eliminar-img';
  btn.textContent = '✕';
  btn.type = 'button';
  btn.addEventListener('click', e => { e.stopPropagation(); wrapper.remove(); });
  wrapper.appendChild(img);
  wrapper.appendChild(btn);
  return wrapper;
}

function crearWrapperVideo(src, idbRef = null) {
  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';
  if (idbRef) wrapper.dataset.ref = idbRef;
  const video = document.createElement('video');
  video.src = src;
  video.dataset.src = src;
  video.style.width = '68px';
  video.style.height = '68px';
  video.addEventListener('click', () => abrirModalMedia(video.dataset.src || src, 'video'));
  const btn = document.createElement('button');
  btn.className = 'btn-eliminar-video';
  btn.textContent = '✕';
  btn.type = 'button';
  btn.addEventListener('click', e => { e.stopPropagation(); wrapper.remove(); });
  wrapper.appendChild(video);
  wrapper.appendChild(btn);
  return wrapper;
}

function crearCitaCard(p) {
  const badge = badgeInfo(p.revision);
  const card = document.createElement('div');
  card.className = `cita-card ${badge.cardClase}`;
  card.innerHTML = `
    <div class="cita-hora ${p.horaRevision ? '' : 'sin-hora'}">${esc(p.horaRevision) || 'Sin hora'}</div>
    <div class="cita-info">
      <div class="cita-nombre">${esc(p.nombre)} ${esc(p.apellidos)}</div>
      ${p.notaRevision ? `<div class="cita-nota">${esc(p.notaRevision)}</div>` : ''}
    </div>
    <span class="cita-badge ${badge.clase}">${badge.texto}</span>
  `;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Cita de ${p.nombre} ${p.apellidos}`);
  card.addEventListener('click', () => abrirModal(p.id));
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirModal(p.id); } });
  return card;
}

function setBtnGuardar(btn, habilitado) {
  btn.disabled = !habilitado;
  btn.style.opacity = habilitado ? '1' : '0.6';
  btn.style.cursor = habilitado ? 'pointer' : 'not-allowed';
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────────
// El logo del header es el botón que abre/cierra este menú con las 4 secciones.
const SECCION_LABELS = { pacientes: 'Pacientes', agenda: 'Agenda', medicacion: 'Medicación', configuracion: 'Configuración' };

function mostrarSeccion(seccion, btn) {
  document.querySelectorAll('main').forEach(m => m.classList.add('oculto'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`seccion-${seccion}`).classList.remove('oculto');
  btn.classList.add('active');
  const labelActual = document.getElementById('menu-principal-seccion-actual');
  if (labelActual) labelActual.textContent = SECCION_LABELS[seccion] || seccion;
  cerrarMenuPrincipal();
  if (seccion === 'agenda') renderVista();
  if (seccion === 'configuracion') mostrarInfoAlmacenamiento(); // por si el subtab "Datos" ya estaba activo
  if (seccion === 'medicacion') renderResumenMedicacion();
}

function toggleMenuPrincipal() {
  const dropdown = document.getElementById('menu-principal-dropdown');
  const trigger = document.getElementById('btn-menu-principal');
  const seAbre = dropdown.classList.contains('oculto');
  dropdown.classList.toggle('oculto', !seAbre);
  trigger.setAttribute('aria-expanded', String(seAbre));
}

function cerrarMenuPrincipal() {
  document.getElementById('menu-principal-dropdown')?.classList.add('oculto');
  document.getElementById('btn-menu-principal')?.setAttribute('aria-expanded', 'false');
}

document.getElementById('btn-menu-principal').addEventListener('click', e => {
  e.stopPropagation();
  toggleMenuPrincipal();
});
// Cerrar el menú al tocar fuera, o con Escape
document.addEventListener('click', e => {
  const dropdown = document.getElementById('menu-principal-dropdown');
  const trigger = document.getElementById('btn-menu-principal');
  if (!dropdown.classList.contains('oculto') && !dropdown.contains(e.target) && !trigger.contains(e.target)) {
    cerrarMenuPrincipal();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarMenuPrincipal(); });

// "Configuración" agrupa Ajustes (items de tratamiento, catálogo de fármacos) y Datos
// (copia de seguridad JSON, calendario, almacenamiento) bajo una sola pestaña de navegación,
// con este selector interno para elegir cuál de las dos se ve.
function cambiarConfigSubtab(subtab, btn) {
  document.querySelectorAll('#seccion-configuracion .config-subtab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('#seccion-configuracion .vista-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`config-subtab-${subtab}`).classList.add('active');
  btn.classList.add('active');
  if (subtab === 'datos') mostrarInfoAlmacenamiento();
}

// ─── INFORMACIÓN DE ALMACENAMIENTO ────────────────────────────────────────────
async function mostrarInfoAlmacenamiento() {
  const cont = document.getElementById('info-almacenamiento');
  if (!cont) return;
  try {
    let totalBytes = 0, quotaBytes = 0;
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      totalBytes = est.usage || 0;
      quotaBytes = est.quota || 0;
    } else {
      // Fallback para navegadores sin storage.estimate
      const raw = (localStorage.getItem('pacientes') || '') + (localStorage.getItem('itemsTratamiento') || '');
      totalBytes = raw.length * 2;
      quotaBytes = 5 * 1024 * 1024;
    }

    const totalMB = (totalBytes / (1024 * 1024)).toFixed(0);
    const quotaGB = quotaBytes > 0 ? (quotaBytes / (1024 * 1024 * 1024)).toFixed(1) : '?';
    const porcentaje = quotaBytes > 0 ? Math.min(totalBytes / quotaBytes * 100, 100).toFixed(1) : '0';

    const datos = cargarJSON('pacientes', []);
    let numFotos = 0, numImagenes = 0, numVideos = 0;
    datos.forEach(p => {
      if (p.foto) numFotos++;
      if (p.imagenes) numImagenes += p.imagenes.length;
      if (p.videos) numVideos += p.videos.length;
    });

    const pct = parseFloat(porcentaje);
    const color = pct > 80 ? 'var(--danger)' : pct > 60 ? 'var(--warning)' : 'var(--text)';
    const alertaMsg = pct > 80
      ? `<p style="color:var(--danger);font-size:13px;margin-top:10px;font-weight:600;">🔴 Almacenamiento casi lleno. Haz una copia de seguridad.</p>`
      : pct > 60
      ? `<p style="color:var(--warning);font-size:13px;margin-top:10px;font-weight:500;">⚠️ El almacenamiento está al ${porcentaje}%. Considera hacer una copia pronto.</p>`
      : `<p style="color:var(--text);font-size:13px;margin-top:10px;font-weight:500;">✅ Almacenamiento disponible. Las fotos y vídeos se guardan en el dispositivo.</p>`;

    cont.innerHTML = `
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
          <span style="color:var(--text-muted);">Espacio usado</span>
          <span style="font-weight:700;color:${color};">${totalMB} MB / ${quotaGB} GB</span>
        </div>
        <div style="background:var(--border);border-radius:4px;height:10px;overflow:hidden;">
          <div style="width:${porcentaje}%;background:${color};height:100%;border-radius:4px;transition:width 0.4s;"></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;margin-top:12px;">
        <div style="background:var(--bg);padding:10px 6px;border-radius:10px;">
          <div style="font-size:22px;">📷</div>
          <div style="font-size:20px;font-weight:700;color:var(--text);">${numFotos}</div>
          <div style="font-size:11px;color:var(--text-muted);">Fotos perfil</div>
        </div>
        <div style="background:var(--bg);padding:10px 6px;border-radius:10px;">
          <div style="font-size:22px;">🖼️</div>
          <div style="font-size:20px;font-weight:700;color:var(--text);">${numImagenes}</div>
          <div style="font-size:11px;color:var(--text-muted);">Imágenes pruebas</div>
        </div>
        <div style="background:var(--bg);padding:10px 6px;border-radius:10px;">
          <div style="font-size:22px;">🎥</div>
          <div style="font-size:20px;font-weight:700;color:var(--text);">${numVideos}</div>
          <div style="font-size:11px;color:var(--text-muted);">Vídeos</div>
        </div>
      </div>
      ${alertaMsg}
    `;
  } catch (e) {
    cont.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No se pudo leer la información del almacenamiento.</p>';
  }
}

function cambiarVista(vista, btn) {
  vistaActual = vista;
  document.querySelectorAll('.vista-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('vista-dia').classList.add('oculto');
  document.getElementById('vista-semana').classList.add('oculto');
  document.getElementById('vista-mes').classList.add('oculto');
  document.getElementById(`vista-${vista}`).classList.remove('oculto');
  renderVista();
}

function renderVista() {
  if (vistaActual === 'dia') renderDia();
  else if (vistaActual === 'semana') renderSemana();
  else renderMes();
}

// ─── VISTA DÍA ────────────────────────────────────────────────────────────────
function renderDia() {
  const hoy = fechaHoy();
  const iso = toISO(fechaDia);
  const diasSemana = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  document.getElementById('label-dia-semana').textContent =
    iso === hoy ? `Hoy — ${diasSemana[fechaDia.getDay()]} ${formatearFecha(iso)}` : `${diasSemana[fechaDia.getDay()]} ${formatearFecha(iso)}`;
  document.getElementById('selector-dia').value = iso;

  const citas = citasEnFecha(iso);
  const contenedor = document.getElementById('lista-dia');
  contenedor.innerHTML = '';
  if (citas.length === 0) {
    contenedor.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><p>No hay citas para este día.</p></div>`;
    return;
  }
  citas.forEach(p => contenedor.appendChild(crearCitaCard(p)));
}

function cambiarDia(delta) {
  fechaDia.setDate(fechaDia.getDate() + delta);
  renderDia();
}

function seleccionarDia(valor) {
  fechaDia = new Date(valor + 'T12:00:00');
  renderDia();
}

// ─── VISTA SEMANA ─────────────────────────────────────────────────────────────
function renderSemana() {
  const d = new Date(fechaSemana);
  const dia = d.getDay();
  const diffLunes = dia === 0 ? -6 : 1 - dia;
  d.setDate(d.getDate() + diffLunes);

  const lunes = new Date(d);
  const domingo = new Date(d);
  domingo.setDate(domingo.getDate() + 6);

  document.getElementById('label-semana').textContent =
    `${formatearFecha(toISO(lunes))} — ${formatearFecha(toISO(domingo))}`;

  const hoy = fechaHoy();
  const grid = document.getElementById('grid-semana');
  grid.innerHTML = '';

  for (let i = 0; i < 7; i++) {
    const dia = new Date(lunes);
    dia.setDate(dia.getDate() + i);
    const isoD = toISO(dia);
    const citas = citasEnFecha(isoD);

    const col = document.createElement('div');
    col.className = `semana-col${isoD === hoy ? ' es-hoy' : ''}`;
    col.innerHTML = `
      <div class="semana-col-header">
        <div class="semana-dia-nombre">${DIAS[dia.getDay()]}</div>
        <div class="semana-dia-num">${dia.getDate()}</div>
      </div>
      <div class="semana-citas">
        ${citas.map(p => {
          const badge = badgeInfo(p.revision);
          return `<div class="semana-cita ${badge.cardClase}" data-id="${p.id}">
            ${p.horaRevision ? esc(p.horaRevision) + ' ' : ''}${esc(p.nombre)}
          </div>`;
        }).join('')}
      </div>
    `;
    col.querySelectorAll('.semana-cita').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); abrirModal(parseInt(el.dataset.id)); });
    });
    grid.appendChild(col);
  }
}

function cambiarSemana(delta) {
  fechaSemana.setDate(fechaSemana.getDate() + delta * 7);
  renderSemana();
}

// ─── VISTA MES ────────────────────────────────────────────────────────────────
function renderMes() {
  const año = fechaMes.getFullYear();
  const mes = fechaMes.getMonth();
  document.getElementById('label-mes').textContent = `${MESES[mes]} ${año}`;

  const hoy = fechaHoy();
  const cal = document.getElementById('calendario-mes');
  cal.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  for (let d = 0; d < 7; d++) {
    const dayName = document.createElement('div');
    dayName.className = 'cal-dia-nombre';
    dayName.textContent = DIAS[d];
    grid.appendChild(dayName);
  }

  const primero = new Date(año, mes, 1, 12, 0, 0);
  const ultimo = new Date(año, mes + 1, 0, 12, 0, 0);
  const anterior = new Date(año, mes, 0, 12, 0, 0);

  for (let i = primero.getDay() - 1; i >= 0; i--) {
    const celda = document.createElement('div');
    celda.className = 'cal-celda otro-mes';
    celda.textContent = anterior.getDate() - i;
    grid.appendChild(celda);
  }

  for (let i = 1; i <= ultimo.getDate(); i++) {
    const isoD = toISO(new Date(año, mes, i, 12, 0, 0));
    const citas = citasEnFecha(isoD);
    const celda = document.createElement('div');
    celda.className = `cal-celda${isoD === hoy ? ' es-hoy' : ''}${diaSeleccionadoMes === isoD ? ' seleccionado' : ''}`;
    celda.innerHTML = `<div class="cal-num">${i}</div>`;
    citas.forEach(() => {
      const punto = document.createElement('div');
      punto.className = 'cal-punto';
      celda.appendChild(punto);
    });
    celda.addEventListener('click', () => { diaSeleccionadoMes = isoD; renderMes(); });
    grid.appendChild(celda);
  }

  for (let i = 1; i <= (6 * 7 - primero.getDay() - ultimo.getDate()); i++) {
    const celda = document.createElement('div');
    celda.className = 'cal-celda otro-mes';
    celda.textContent = i;
    grid.appendChild(celda);
  }

  cal.appendChild(grid);

  const lista = document.getElementById('lista-mes-detalle');
  lista.innerHTML = '';
  if (diaSeleccionadoMes) {
    const citas = citasEnFecha(diaSeleccionadoMes);
    if (citas.length > 0) {
      const titulo = document.createElement('div');
      titulo.className = 'mes-detalle-titulo';
      titulo.textContent = formatearFechaCompleta(diaSeleccionadoMes);
      lista.appendChild(titulo);
      citas.forEach(p => lista.appendChild(crearCitaCard(p)));
    }
  }
}

function cambiarMes(delta) {
  fechaMes.setMonth(fechaMes.getMonth() + delta);
  diaSeleccionadoMes = null;
  renderMes();
}

function irAHoy() {
  fechaDia = new Date();
  fechaSemana = new Date();
  fechaMes = new Date();
  diaSeleccionadoMes = null;
  renderVista();
}

// ─── PACIENTES ────────────────────────────────────────────────────────────────
function mostrarPacientes(lista) {
  const contenedor = document.getElementById('lista-pacientes');
  const contador = document.getElementById('contador-pacientes');
  if (contador) {
    const total = pacientes.length;
    contador.textContent = lista.length === total
      ? `${total} paciente${total !== 1 ? 's' : ''}`
      : `${lista.length} de ${total} paciente${total !== 1 ? 's' : ''}`;
  }
  contenedor.innerHTML = '';
  if (lista.length === 0) {
    contenedor.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><p>No hay pacientes registrados.<br>Pulsa "+ Nuevo paciente" para empezar.</p></div>`;
    return;
  }
  lista.forEach(p => {
    let revisionHTML = '';
    if (p.revision) {
      const badge = badgeInfo(p.revision);
      const claseColor = badge.clase === 'badge-rojo' ? 'tarjeta-revision-vencida'
        : badge.clase === 'badge-naranja' ? 'tarjeta-revision-hoy'
        : 'tarjeta-revision-proxima';
      revisionHTML = `<div class="tarjeta-revision-badge ${claseColor}">${badge.texto} · ${formatearFecha(p.revision)}${p.horaRevision ? ' · ' + esc(p.horaRevision) : ''}</div>`;
    }
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta-paciente';
    tarjeta.innerHTML = `
      <div class="tarjeta-avatar">${iniciales(p.nombre, p.apellidos)}</div>
      <div class="tarjeta-info">
        <div class="tarjeta-nombre">${esc(p.nombre)} ${esc(p.apellidos)}</div>
        <div class="tarjeta-meta">ID: ${p.id}${calcularEdad(p.fechaNacimiento) ? ' · ' + calcularEdad(p.fechaNacimiento) : ''}</div>
        <div class="tarjeta-diagnostico">${p.diagnostico ? '📋 ' + esc(p.diagnostico) : 'Sin diagnóstico registrado'}</div>
        ${revisionHTML}
      </div>
      <span class="tarjeta-chevron">›</span>
    `;
    tarjeta.setAttribute('role', 'button');
    tarjeta.setAttribute('tabindex', '0');
    tarjeta.setAttribute('aria-label', `Paciente ${p.nombre} ${p.apellidos}`);
    tarjeta.addEventListener('click', () => abrirModal(p.id));
    tarjeta.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirModal(p.id); } });
    contenedor.appendChild(tarjeta);

    // Carga la foto de forma asíncrona (IndexedDB), sin bloquear el render
    if (p.foto) {
      resolverURL(p.foto).then(url => {
        if (!url || !tarjeta.isConnected) return;
        const avatar = tarjeta.querySelector('.tarjeta-avatar');
        if (!avatar) return;
        const img = document.createElement('img');
        img.className = 'tarjeta-foto';
        img.src = url;
        img.alt = 'foto';
        tarjeta.replaceChild(img, avatar);
      });
    }
  });
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function limpiarVideos(contenedorId) {
  const cont = document.getElementById(contenedorId);
  cont.querySelectorAll('video').forEach(v => { v.src = ''; v.load(); });
  cont.innerHTML = '';
}

async function abrirModal(id = null) {
  _elementoQueAbrioModal = document.activeElement;
  const session = ++modalSession; // invalida callbacks async de aperturas anteriores
  pacienteEditandoId = id;
  evolucionesAñadidas = [];
  fotoPendienteBlob = null;
  modalModificado = false;
  actualizarDatalistFarmacos();

  // Resetear subtabs a la pestaña Datos (tab 0)
  resetSubtabs();
  document.getElementById('subtab-0')?.classList.add('active');
  document.querySelector('.subtab-btn')?.classList.add('active');

  const preview = document.getElementById('preview-foto');
  document.getElementById('preview-imagenes').innerHTML = '';
  limpiarVideos('preview-videos');
  document.getElementById('evoluciones-list').innerHTML = '';
  const btnEliminar = document.getElementById('btn-eliminar');

  if (id) {
    const p = pacientes.find(p => p.id === id);
    document.getElementById('modal-titulo').textContent = 'Ficha del paciente';
    btnEliminar.classList.remove('oculto');

    // Cabecera fija
    const headerEl = document.getElementById('modal-header-paciente');
    headerEl.classList.remove('oculto');
    headerEl.style.display = 'flex';
    document.getElementById('modal-header-nombre').textContent = `${p.nombre} ${p.apellidos}`;
    document.getElementById('modal-header-meta').textContent = calcularEdad(p.fechaNacimiento) || '';
    document.getElementById('modal-header-foto-hint').textContent = p.foto ? '📷 Cambiar foto de perfil' : '📷 Añadir foto de perfil';
    const headerFoto = document.getElementById('modal-header-foto');
    const headerAvatar = document.getElementById('modal-header-avatar');
    headerFoto.style.display = 'none';
    headerAvatar.style.display = 'flex';
    headerAvatar.textContent = iniciales(p.nombre, p.apellidos);

    // Cargar foto de perfil (async desde IndexedDB)
    preview.src = '';
    if (p.foto) {
      resolverURL(p.foto).then(url => {
        if (session !== modalSession || !url) return;
        preview.src = url;
        headerFoto.src = url;
        headerFoto.style.display = 'block';
        headerAvatar.style.display = 'none';
        document.getElementById('modal-header-foto-hint').textContent = '📷 Cambiar foto de perfil';
      });
    }

    document.getElementById('input-nombre').value = p.nombre;
    document.getElementById('input-apellidos').value = p.apellidos;
    document.getElementById('input-fecha').value = p.fechaNacimiento;
    document.getElementById('input-situacion-basal').value = p.situacionBasal || '';
    document.getElementById('input-diagnostico').value = p.diagnostico || '';
    document.getElementById('input-tratamiento').value = p.tratamiento || '';
    document.getElementById('input-evolucion').value = '';
    document.getElementById('input-revision').value = p.revision || '';
    document.getElementById('input-hora-revision').value = p.horaRevision || '';
    document.getElementById('input-nota-revision').value = p.notaRevision || '';
    document.getElementById('edad-calculada').textContent = calcularEdad(p.fechaNacimiento) ? `Edad: ${calcularEdad(p.fechaNacimiento)}` : '';
    establecerGenero(p.genero || '');

    // Cargar imágenes (async desde IndexedDB)
    if (p.imagenes?.length > 0) {
      const cont = document.getElementById('preview-imagenes');
      p.imagenes.forEach(ref => {
        resolverURL(ref).then(url => {
          if (session !== modalSession || !url) return;
          cont.appendChild(crearWrapperImagen(url, ref));
        });
      });
    }

    // Cargar vídeos (async desde IndexedDB)
    if (p.videos?.length > 0) {
      const cont = document.getElementById('preview-videos');
      p.videos.forEach(ref => {
        resolverURL(ref).then(url => {
          if (session !== modalSession || !url) return;
          cont.appendChild(crearWrapperVideo(url, ref));
        });
      });
    }

    if (p.evoluciones?.length > 0) renderEvolucionesAnteriores(p.evoluciones);
    renderItemsTratamiento(id);
    medicacionesEnModal = JSON.parse(JSON.stringify(p.medicaciones || []));
    limpiarFormMedicacion();
    renderMedicaciones();
  } else {
    document.getElementById('modal-titulo').textContent = 'Nuevo paciente';
    btnEliminar.classList.add('oculto');
    const headerEl = document.getElementById('modal-header-paciente');
    headerEl.classList.remove('oculto');
    headerEl.style.display = 'flex';
    document.getElementById('modal-header-nombre').textContent = '';
    document.getElementById('modal-header-meta').textContent = '';
    document.getElementById('modal-header-foto-hint').textContent = '📷 Añadir foto de perfil';
    const headerFoto = document.getElementById('modal-header-foto');
    const headerAvatar = document.getElementById('modal-header-avatar');
    headerFoto.style.display = 'none';
    headerFoto.src = '';
    headerAvatar.style.display = 'flex';
    headerAvatar.textContent = '📷';
    ['input-nombre','input-apellidos','input-situacion-basal','input-diagnostico','input-tratamiento','input-evolucion','input-nota-revision'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('input-fecha').value = '';
    document.getElementById('input-revision').value = '';
    document.getElementById('input-hora-revision').value = '';
    document.getElementById('edad-calculada').textContent = '';
    establecerGenero('');
    preview.src = '';
    renderItemsTratamiento(null);
    medicacionesEnModal = [];
    limpiarFormMedicacion();
    renderMedicaciones();
  }

  document.getElementById('fecha-evolutivo').textContent = formatearFechaCompleta(fechaHoy());
  document.getElementById('modal').classList.remove('oculto');
  // Focus trap + mover foco al primer elemento del modal
  if (_focusTrapCleanup) _focusTrapCleanup();
  _focusTrapCleanup = crearFocusTrap(document.querySelector('.modal-contenido'));
  const primerFocusable = document.querySelector('.modal-contenido button:not([disabled]), .modal-contenido input:not([disabled])');
  if (primerFocusable) primerFocusable.focus();
}

function renderItemsTratamiento(pacienteId) {
  const cont = document.getElementById('items-tratamiento-checkboxes');
  cont.innerHTML = '';
  if (itemsTratamiento.length === 0) { cont.style.display = 'none'; return; }
  cont.style.display = 'block';

  const titulo = document.createElement('div');
  titulo.style.cssText = 'font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 8px;';
  titulo.textContent = 'Tratamientos aplicados';
  cont.appendChild(titulo);

  itemsTratamiento.forEach((item, idx) => {
    const label = document.createElement('label');
    label.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px; cursor: pointer; font-size: 14px;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `item-${idx}`;
    checkbox.style.cssText = 'width: 18px; height: 18px; cursor: pointer;';
    if (pacienteEditandoId) {
      const paciente = pacientes.find(p => p.id === pacienteEditandoId);
      if (paciente?.itemsTratamiento?.[idx]) checkbox.checked = true;
    }
    const text = document.createElement('span');
    text.textContent = item;
    label.appendChild(checkbox);
    label.appendChild(text);
    cont.appendChild(label);
  });
}

function renderEvolucionesAnteriores(evoluciones) {
  const cont = document.getElementById('evoluciones-list');
  cont.innerHTML = '';
  if (!evoluciones?.length) return;

  const titulo = document.createElement('div');
  titulo.style.cssText = 'font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin: 12px 0 8px; padding-top: 8px; border-top: 1px solid var(--border);';
  titulo.textContent = 'Histórico de evoluciones';
  cont.appendChild(titulo);

  // Mostrar más reciente primero (copia invertida, sin mutar el array original)
  [...evoluciones].reverse().forEach(evo => {
    const card = document.createElement('div');
    card.style.cssText = 'background: var(--bg); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid var(--accent);';
    card.innerHTML = `
      <div style="font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">${evo.fecha ? formatearFechaCompleta(evo.fecha) : 'Sin fecha'}</div>
      <div style="font-size: 13px; color: var(--text); line-height: 1.5;">${esc(evo.texto)}</div>
    `;
    cont.appendChild(card);
  });
}

// ─── MEDICACIÓN (dentro de la ficha de paciente) ──────────────────────────────

// Fecha de revisión "en vivo": la del formulario si el modal está abierto editando,
// para que el cálculo de comprimidos reaccione al instante si se cambia la cita,
// sin esperar a guardar el paciente.
function revisionActualDelForm() {
  return document.getElementById('input-revision')?.value || '';
}

function limpiarFormMedicacion() {
  document.getElementById('input-med-farmaco').value = '';
  document.getElementById('input-med-concentracion-mg').value = '';
  document.getElementById('input-med-dosis-mg').value = '';
  document.getElementById('input-med-unidades-toma').value = '';
  document.getElementById('input-med-frecuencia').value = '';
  document.getElementById('input-med-fecha-inicio').value = fechaHoy();
  document.getElementById('checkbox-med-auto-fin').checked = true;
  document.getElementById('input-med-fecha-fin').value = '';
  document.getElementById('campo-med-fecha-fin-manual').classList.add('oculto');
  document.getElementById('input-med-notas').value = '';
  medicacionEditandoIdx = null;
  document.getElementById('btn-guardar-medicacion').textContent = '+ Añadir medicación';
  actualizarInfoCatalogoFarmaco();
  actualizarSugerenciaUnidades();
}

function editarMedicacion(idx) {
  const med = medicacionesEnModal[idx];
  if (!med) return;
  document.getElementById('input-med-farmaco').value = med.farmaco || '';
  document.getElementById('input-med-concentracion-mg').value = med.concentracionMgPorUnidad ?? '';
  document.getElementById('input-med-dosis-mg').value = med.dosisMgPorToma ?? med.dosisMg ?? '';
  document.getElementById('input-med-unidades-toma').value = med.unidadesPorToma ?? '';
  document.getElementById('input-med-frecuencia').value = med.frecuencia || '';
  document.getElementById('input-med-fecha-inicio').value = med.fechaInicio || '';
  document.getElementById('checkbox-med-auto-fin').checked = !!med.autoFin;
  document.getElementById('input-med-fecha-fin').value = med.autoFin ? '' : (med.fechaFin || '');
  document.getElementById('campo-med-fecha-fin-manual').classList.toggle('oculto', !!med.autoFin);
  document.getElementById('input-med-notas').value = med.notas || '';
  medicacionEditandoIdx = idx;
  document.getElementById('btn-guardar-medicacion').textContent = '✓ Guardar cambios';
  actualizarInfoCatalogoFarmaco();
  actualizarSugerenciaUnidades();
  document.getElementById('input-med-farmaco').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Muestra debajo del campo "Fármaco" la concentración/unidad ya definidas en el catálogo,
// para que el médico vea de un vistazo con qué está trabajando antes de rellenar la dosis.
function actualizarInfoCatalogoFarmaco() {
  const cont = document.getElementById('med-farmaco-info-catalogo');
  if (!cont) return;
  const nombre = document.getElementById('input-med-farmaco').value.trim();
  const catalogo = buscarFarmacoCatalogo(nombre);
  if (!nombre || !catalogo) { cont.innerHTML = ''; return; }
  const unidad = unidadLabelFarmaco(nombre);
  const partes = [];
  if (catalogo.concentracionMg > 0) partes.push(`${catalogo.concentracionMg} mg por ${unidad.replace(/s$/, '')}`);
  const porCaja = unidadesPorCajaCatalogo(catalogo);
  if (porCaja > 0) partes.push(`${porCaja} ${unidad}/caja`);
  cont.innerHTML = partes.length
    ? `📋 En catálogo: ${esc(partes.join(' · '))}`
    : `📋 "${esc(nombre)}" está en el catálogo pero sin mg ni caja definidos todavía.`;
}

// Convierte la dosis en mg a nº de unidades usando la concentración (mg por comprimido/cápsula),
// y ofrece un botón para volcar esa sugerencia al campo "unidades por toma" (el que se usa en el cálculo).
// La concentración se toma primero del propio formulario (puede ajustarse por medicación) y,
// si está vacío, del catálogo de fármacos como valor de referencia.
function actualizarSugerenciaUnidades() {
  const cont = document.getElementById('med-sugerencia-unidades');
  if (!cont) return;
  const nombre = document.getElementById('input-med-farmaco').value.trim();
  const dosisMg = parseFloat(document.getElementById('input-med-dosis-mg').value);
  const catalogo = buscarFarmacoCatalogo(nombre);
  const concentracionForm = parseFloat(document.getElementById('input-med-concentracion-mg').value);
  const concentracion = concentracionForm > 0 ? concentracionForm : parseFloat(catalogo?.concentracionMg);

  if (!dosisMg) { cont.innerHTML = ''; return; }
  if (!concentracion) {
    cont.innerHTML = `⚠️ Indica cuántos "mg por comprimido/cápsula" tiene ${nombre ? `"${esc(nombre)}"` : 'este fármaco'} (arriba, o en Configuración → Catálogo de Fármacos) para poder convertir esta dosis a comprimidos automáticamente.`;
    return;
  }
  const unidad = unidadLabelFarmaco(nombre);
  const sugerido = dosisMg / concentracion;
  const sugeridoTexto = Number.isInteger(sugerido) ? sugerido : sugerido.toFixed(2).replace(/\.?0+$/, '');
  const avisoFraccion = !Number.isInteger(sugerido)
    ? ' — revisa si se puede fraccionar o si la dosis/concentración son correctas'
    : '';
  cont.innerHTML = `
    💡 ${sugeridoTexto} ${esc(unidad)} por toma${avisoFraccion}
    <button type="button" class="btn-usar-sugerencia" id="btn-usar-sugerencia-unidades">Usar</button>
  `;
  document.getElementById('btn-usar-sugerencia-unidades').addEventListener('click', () => {
    document.getElementById('input-med-unidades-toma').value = sugeridoTexto;
  });
}

function eliminarMedicacion(idx) {
  medicacionesEnModal.splice(idx, 1);
  modalModificado = true;
  if (medicacionEditandoIdx === idx) limpiarFormMedicacion();
  renderMedicaciones();
}

function renderMedicaciones() {
  const cont = document.getElementById('lista-medicaciones');
  if (!cont) return;
  cont.innerHTML = '';
  const fechaRevisionRef = revisionActualDelForm();

  if (medicacionesEnModal.length === 0) {
    cont.innerHTML = `<div class="empty-state-mini">Sin medicación registrada todavía.</div>`;
  } else {
    const hoy = fechaHoy();
    // Activas/en curso primero (abiertas por defecto), finalizadas al final y colapsadas —
    // así con meses de historial la pestaña no se llena de tratamientos ya terminados.
    const conEstado = medicacionesEnModal.map((med, idx) => {
      const fin = resolverFinMedicacion(med, fechaRevisionRef);
      const finalizada = fin !== '' && fin < hoy;
      return { med, idx, fin, finalizada };
    });
    const ordenadas = [...conEstado].sort((a, b) => {
      if (a.finalizada !== b.finalizada) return a.finalizada ? 1 : -1;
      return b.idx - a.idx; // más recientes primero dentro de cada grupo
    });

    ordenadas.forEach(({ med, idx, fin, finalizada }) => {
      const total = comprimidosTotalesMedicacion(med, fechaRevisionRef);
      const cajas = cajasNecesarias(med.farmaco, total);
      const unidad = unidadLabelFarmaco(med.farmaco);
      const dosisMgTexto = med.dosisMgPorToma ?? med.dosisMg;
      const concentracionTexto = med.concentracionMgPorUnidad;

      const estadoTexto = finalizada
        ? `Finalizada el ${formatearFecha(fin)}`
        : fin
          ? `Activa hasta el ${formatearFecha(fin)}`
          : (med.autoFin ? 'En curso — sin revisión fijada' : 'En curso');

      const rangoTexto = `${med.fechaInicio ? formatearFecha(med.fechaInicio) : '¿?'} → ${
        fin ? formatearFecha(fin) : (med.autoFin ? 'próxima revisión (sin fijar)' : '¿?')
      }`;
      const infoMgPartes = [];
      if (dosisMgTexto) infoMgPartes.push(`${esc(dosisMgTexto)} mg`);
      if (concentracionTexto) infoMgPartes.push(`${esc(concentracionTexto)} mg/${unidad.replace(/s$/, '')}`);
      const porTomaTexto = `${med.unidadesPorToma ?? 1} ${unidad} por toma${infoMgPartes.length ? ` (${infoMgPartes.join(' · ')})` : ''}`;
      const totalTexto = (total !== null)
        ? `➡️ ${total} ${unidad}${cajas !== null ? ` · ${cajas} caja${cajas !== 1 ? 's' : ''}` : ''}`
        : `⚠️ Falta fecha de inicio, fecha de fin, o "unidades por toma" para poder calcular`;

      const details = document.createElement('details');
      details.className = `medicacion-card${finalizada ? ' medicacion-card-finalizada' : ''}`;
      details.open = !finalizada;
      details.innerHTML = `
        <summary>
          <span class="medicacion-farmaco">💊 ${esc(med.farmaco)}</span>
          <span class="medicacion-resumen-linea">${esc(estadoTexto)}${total !== null ? ` · ${total} ${esc(unidad)}` : ''}</span>
        </summary>
        <div class="medicacion-card-body">
          <div class="medicacion-card-acciones">
            <button type="button" class="btn-icono-editar" data-idx="${idx}" aria-label="Editar medicación">✏️</button>
            <button type="button" class="btn-icono-eliminar" data-idx="${idx}" aria-label="Eliminar medicación">✕</button>
          </div>
          <div class="medicacion-detalle">${porTomaTexto} · ${med.frecuencia || 0}x/día · ${esc(rangoTexto)}</div>
          <div class="medicacion-total${total === null ? ' medicacion-total-aviso' : ''}">${totalTexto}</div>
          ${med.notas ? `<div class="medicacion-notas">${esc(med.notas)}</div>` : ''}
        </div>
      `;
      cont.appendChild(details);
    });
  }

  cont.querySelectorAll('.btn-icono-editar').forEach(b => b.addEventListener('click', () => editarMedicacion(parseInt(b.dataset.idx, 10))));
  cont.querySelectorAll('.btn-icono-eliminar').forEach(b => b.addEventListener('click', () => eliminarMedicacion(parseInt(b.dataset.idx, 10))));

  actualizarResumenMedicacionCita();
}

// Pequeño resumen en la pestaña "Próxima Cita" de cuánta medicación depende de esa fecha,
// para que quede claro que cambiar la cita recalcula automáticamente las cantidades.
// Se lista fármaco por fármaco (en vez de sumar un único total) porque cada uno puede
// tener su propia unidad — comprimidos, cápsulas, ml — y sumarlas todas juntas no tendría sentido.
function actualizarResumenMedicacionCita() {
  const cont = document.getElementById('medicacion-resumen-cita');
  if (!cont) return;
  const fechaRevisionRef = revisionActualDelForm();
  const medsAutoFin = medicacionesEnModal.filter(m => m.autoFin);
  if (medsAutoFin.length === 0) { cont.innerHTML = ''; return; }

  if (!fechaRevisionRef) {
    cont.innerHTML = `<div class="medicacion-resumen-cita-aviso">💊 ${medsAutoFin.length} medicación${medsAutoFin.length !== 1 ? 'es' : ''} vinculada${medsAutoFin.length !== 1 ? 's' : ''} a "hasta la próxima revisión": fija una fecha de revisión para calcular las cantidades.</div>`;
    return;
  }
  const lineas = medsAutoFin.map(m => {
    const total = comprimidosTotalesMedicacion(m, fechaRevisionRef);
    const unidad = unidadLabelFarmaco(m.farmaco);
    return `${esc(m.farmaco)}: ${total !== null ? `${total} ${esc(unidad)}` : 'faltan datos para calcular'}`;
  }).join(' · ');
  cont.innerHTML = `<div class="medicacion-resumen-cita-info">💊 Vinculada${medsAutoFin.length !== 1 ? 's' : ''} a esta cita hasta el ${formatearFecha(fechaRevisionRef)} — ${lineas}</div>`;
}

function actualizarDatalistFarmacos() {
  const dl = document.getElementById('lista-farmacos-datalist');
  if (!dl) return;
  dl.innerHTML = farmacos.map(f => `<option value="${esc(f.nombre)}">`).join('');
}

function resetSubtabs() {
  document.querySelectorAll('.subtab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
}

function cambiarSubtab(tabIndex, btn) {
  const subtab = document.getElementById(`subtab-${tabIndex}`);
  if (!subtab) return;
  document.querySelectorAll('body > div[style*="position: fixed"]').forEach(m => m.remove());
  resetSubtabs();
  subtab.classList.add('active');
  btn.classList.add('active');
}

async function cerrarModal() {
  if (modalModificado || evolucionesAñadidas.length > 0) {
    const ok = await mostrarConfirm('Tienes cambios sin guardar. ¿Cerrar sin guardar?', { textoOk: 'Cerrar sin guardar', textoCancel: 'Volver' });
    if (!ok) return;
  }
  modalModificado = false;
  fotoPendienteBlob = null;
  document.getElementById('modal').classList.add('oculto');
  limpiarVideos('preview-videos');
  document.getElementById('buscador').value = '';
  filtrarYMostrar();
  pacienteEditandoId = null;
  evolucionesAñadidas = [];
  medicacionesEnModal = [];
  medicacionEditandoIdx = null;
  // Limpiar focus trap y devolver foco al elemento que abrió el modal
  if (_focusTrapCleanup) { _focusTrapCleanup(); _focusTrapCleanup = null; }
  if (_elementoQueAbrioModal) { _elementoQueAbrioModal.focus(); _elementoQueAbrioModal = null; }
}

// ─── EVENTOS ──────────────────────────────────────────────────────────────────
document.getElementById('selector-genero').addEventListener('change', () => { modalModificado = true; });

// Marcar modal como modificado al cambiar cualquier campo
['input-nombre','input-apellidos','input-fecha','input-situacion-basal','input-diagnostico','input-tratamiento',
 'input-evolucion','input-revision','input-hora-revision','input-nota-revision'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => { modalModificado = true; });
});
['input-foto','input-imagenes','input-videos'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { modalModificado = true; });
});

// Cambiar la fecha de revisión recalcula al instante las medicaciones "hasta la próxima revisión"
document.getElementById('input-revision').addEventListener('input', () => {
  renderMedicaciones();
});

// ─── FORMULARIO DE MEDICACIÓN ──────────────────────────────────────────────────
document.getElementById('checkbox-med-auto-fin').addEventListener('change', function() {
  document.getElementById('campo-med-fecha-fin-manual').classList.toggle('oculto', this.checked);
});

// Al escribir/elegir el fármaco: muestra su ficha del catálogo (mg/unidad, unidades/caja) y,
// si el campo de concentración todavía está vacío, lo rellena con el valor del catálogo como
// punto de partida — sin pisar nunca un valor que el médico ya haya escrito a mano.
document.getElementById('input-med-farmaco').addEventListener('input', function() {
  actualizarInfoCatalogoFarmaco();
  const inputConcentracion = document.getElementById('input-med-concentracion-mg');
  if (inputConcentracion && !inputConcentracion.value) {
    const catalogo = buscarFarmacoCatalogo(this.value.trim());
    if (catalogo?.concentracionMg > 0) inputConcentracion.value = catalogo.concentracionMg;
  }
  actualizarSugerenciaUnidades();
});

// Al escribir la concentración (mg por comprimido/cápsula) o la dosis en mg: recalcula la sugerencia
document.getElementById('input-med-concentracion-mg').addEventListener('input', actualizarSugerenciaUnidades);
document.getElementById('input-med-dosis-mg').addEventListener('input', actualizarSugerenciaUnidades);

document.getElementById('btn-guardar-medicacion').addEventListener('click', function() {
  const farmaco = document.getElementById('input-med-farmaco').value.trim();
  const concentracionMgStr = document.getElementById('input-med-concentracion-mg').value.trim();
  const dosisMgPorToma = document.getElementById('input-med-dosis-mg').value.trim();
  const unidadesPorTomaStr = document.getElementById('input-med-unidades-toma').value;
  const frecuencia = parseFloat(document.getElementById('input-med-frecuencia').value);
  const fechaInicio = document.getElementById('input-med-fecha-inicio').value;
  const autoFin = document.getElementById('checkbox-med-auto-fin').checked;
  const fechaFinManual = document.getElementById('input-med-fecha-fin').value;
  const notas = document.getElementById('input-med-notas').value.trim();
  const unidadesPorToma = parseFloat(unidadesPorTomaStr);

  if (!farmaco) { mostrarToast('Indica el nombre del fármaco', 'aviso'); return; }
  if (!unidadesPorTomaStr || isNaN(unidadesPorToma) || unidadesPorToma <= 0) {
    mostrarToast('Indica cuántos comprimidos/cápsulas se toman cada vez (no los mg)', 'aviso'); return;
  }
  if (!frecuencia || frecuencia <= 0) { mostrarToast('Indica cuántas veces al día se toma', 'aviso'); return; }
  if (!fechaInicio) { mostrarToast('Indica la fecha de inicio del tratamiento', 'aviso'); return; }
  if (!autoFin && !fechaFinManual) { mostrarToast('Indica la fecha de fin, o marca "Hasta la próxima revisión"', 'aviso'); return; }

  const esNueva = medicacionEditandoIdx === null;
  const anterior = esNueva ? null : medicacionesEnModal[medicacionEditandoIdx];

  const medicacion = {
    id: anterior ? anterior.id : Date.now(),
    farmaco, concentracionMgPorUnidad: concentracionMgStr, dosisMgPorToma, unidadesPorToma, frecuencia, fechaInicio, autoFin,
    fechaFin: autoFin ? '' : fechaFinManual,
    notas,
  };

  if (esNueva) {
    medicacionesEnModal.push(medicacion);
  } else {
    medicacionesEnModal[medicacionEditandoIdx] = medicacion;
  }

  // Auto-registrar en el evolutivo cuando se añade una medicación nueva o cambia su dosis/unidades/frecuencia/fármaco,
  // para que quede constancia del ajuste de tratamiento sin tener que escribirlo aparte.
  const cambioRelevante = esNueva || !anterior ||
    anterior.unidadesPorToma !== medicacion.unidadesPorToma || anterior.dosisMgPorToma !== medicacion.dosisMgPorToma ||
    anterior.concentracionMgPorUnidad !== medicacion.concentracionMgPorUnidad ||
    anterior.frecuencia !== medicacion.frecuencia || anterior.farmaco !== medicacion.farmaco;
  if (cambioRelevante) {
    const finTexto = medicacion.autoFin ? 'hasta la próxima revisión' : `hasta ${formatearFecha(medicacion.fechaFin)}`;
    const unidad = unidadLabelFarmaco(medicacion.farmaco);
    const concentracionTexto = medicacion.concentracionMgPorUnidad ? ` (${medicacion.concentracionMgPorUnidad} mg/${unidad.replace(/s$/, '')})` : '';
    const texto = `💊 ${esNueva ? 'Nueva medicación' : 'Medicación actualizada'}: ${medicacion.farmaco}${concentracionTexto} — ${medicacion.unidadesPorToma} ${unidad} por toma${medicacion.dosisMgPorToma ? ` (${medicacion.dosisMgPorToma} mg)` : ''}, ${medicacion.frecuencia}x/día ${finTexto}.`;
    agregarEvolucionAlModal(texto);
  }

  modalModificado = true;
  limpiarFormMedicacion();
  renderMedicaciones();
  mostrarToast(esNueva ? '✅ Medicación añadida' : '✅ Medicación actualizada', 'exito');
});

document.getElementById('btn-cancelar-medicacion').addEventListener('click', () => limpiarFormMedicacion());

// Tap en cabecera: foto → zoom; avatar o hint → seleccionar archivo
document.getElementById('modal-header-foto').addEventListener('click', function() {
  if (this.src) abrirModalMedia(this.src, 'imagen');
});
document.getElementById('modal-header-avatar').addEventListener('click', () => document.getElementById('input-foto').click());
document.getElementById('modal-header-foto-hint').addEventListener('click', () => document.getElementById('input-foto').click());

// Foto de perfil — comprime antes de mostrar y guardar
document.getElementById('input-foto').addEventListener('change', function() {
  if (!this.files[0]) return;
  comprimirImagen(this.files[0]).then(blob => {
    fotoPendienteBlob = blob;
    const url = URL.createObjectURL(blob);
    document.getElementById('preview-foto').src = url;
    const headerFoto = document.getElementById('modal-header-foto');
    const headerAvatar = document.getElementById('modal-header-avatar');
    headerFoto.src = url;
    headerFoto.style.display = 'block';
    headerAvatar.style.display = 'none';
    document.getElementById('modal-header-foto-hint').textContent = '📷 Cambiar foto de perfil';
  });
});

// Actualizar cabecera al escribir nombre/apellidos
['input-nombre', 'input-apellidos'].forEach(inputId => {
  document.getElementById(inputId).addEventListener('input', function() {
    if (document.getElementById('modal-header-paciente').style.display !== 'flex') return;
    const nombre = document.getElementById('input-nombre').value.trim();
    const apellidos = document.getElementById('input-apellidos').value.trim();
    document.getElementById('modal-header-nombre').textContent = `${nombre} ${apellidos}`.trim();
    if (document.getElementById('modal-header-foto').style.display === 'none') {
      const inics = iniciales(nombre, apellidos);
      document.getElementById('modal-header-avatar').textContent = inics || '📷';
    }
  });
});

// Imágenes clínicas — comprime y almacena en pendingBlobs
document.getElementById('input-imagenes').addEventListener('change', function() {
  const cont = document.getElementById('preview-imagenes');
  Array.from(this.files).forEach(archivo => {
    comprimirImagen(archivo).then(blob => {
      const url = URL.createObjectURL(blob);
      const wrapper = crearWrapperImagen(url); // sin idbRef: es nueva
      pendingBlobs.set(wrapper, blob);
      cont.appendChild(wrapper);
    });
  });
});

// Vídeos — almacena el File directamente en pendingBlobs (sin comprimir)
document.getElementById('input-videos').addEventListener('change', function() {
  const cont = document.getElementById('preview-videos');
  Array.from(this.files).forEach(archivo => {
    const url = URL.createObjectURL(archivo);
    const wrapper = crearWrapperVideo(url); // sin idbRef: es nuevo
    pendingBlobs.set(wrapper, archivo);
    cont.appendChild(wrapper);
  });
});

document.getElementById('input-fecha').addEventListener('change', function() {
  const edad = calcularEdad(this.value);
  document.getElementById('edad-calculada').textContent = edad ? `Edad: ${edad}` : '';
});

// Añade una entrada al evolutivo del paciente que se está editando (visible en la pestaña
// Historial) y la deja pendiente de guardar junto con el resto del formulario.
// Se usa tanto desde el botón "+ Añadir Evolutivo" como automáticamente al registrar medicación.
function agregarEvolucionAlModal(texto) {
  const hoy = fechaHoy();
  const nuevaEvo = { fecha: hoy, texto };
  evolucionesAñadidas.push(nuevaEvo);

  const cont = document.getElementById('evoluciones-list');
  if (!cont.querySelector('.evoluciones-titulo-nuevas')) {
    const titulo = document.createElement('div');
    titulo.className = 'evoluciones-titulo-nuevas';
    titulo.style.cssText = 'font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); margin: 12px 0 8px; padding-top: 8px; border-top: 1px solid var(--border);';
    titulo.textContent = 'Nuevas evoluciones en esta revisión';
    cont.appendChild(titulo);
  }

  const card = document.createElement('div');
  card.style.cssText = 'background: var(--accent-light); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid var(--accent); position: relative;';
  card.innerHTML = `
    <div style="font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 4px;">Hoy — ${formatearFechaCompleta(hoy)}</div>
    <div style="font-size: 13px; color: var(--text); line-height: 1.5; padding-right: 28px;">${esc(texto)}</div>
    <button class="btn-eliminar-evo" style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--danger); cursor: pointer; font-size: 18px;">✕</button>
  `;
  card.querySelector('.btn-eliminar-evo').addEventListener('click', () => {
    const i = evolucionesAñadidas.indexOf(nuevaEvo);
    if (i !== -1) evolucionesAñadidas.splice(i, 1);
    card.remove();
  });

  cont.appendChild(card);
}

document.getElementById('btn-añadir-evolucion').addEventListener('click', function() {
  const textoEvo = document.getElementById('input-evolucion').value.trim();
  if (!textoEvo) { mostrarToast('Por favor escribe algo en el campo de evolución', 'aviso'); return; }
  agregarEvolucionAlModal(textoEvo);
  document.getElementById('input-evolucion').value = '';
});

document.getElementById('btn-nuevo').addEventListener('click', () => abrirModal());
document.getElementById('btn-cancelar').addEventListener('click', () => cerrarModal());
// Cerrar modal con Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('modal').classList.contains('oculto')) {
    cerrarModal();
  }
});

// Eliminar paciente — limpia también su media de IndexedDB
document.getElementById('btn-eliminar').addEventListener('click', async function() {
  const p = pacientes.find(p => p.id === pacienteEditandoId);
  const ok = await mostrarConfirm(`¿Eliminar a ${p?.nombre} ${p?.apellidos}?\n\nEsta acción no se puede deshacer.`, { textoOk: 'Eliminar', textoCancel: 'Cancelar', peligro: true });
  if (!ok) return;
  if (p) {
    const refs = [p.foto, ...(p.imagenes || []), ...(p.videos || [])];
    await Promise.all(refs.filter(r => r?.startsWith('idb:')).map(r => dbDelete(r.slice(4))));
  }
  pacientes = pacientes.filter(p => p.id !== pacienteEditandoId);
  if (!guardarDatos()) return;
  await cerrarModal(); // cerrarModal ya llama a mostrarPacientes internamente
});

// Guardar paciente — guarda media en IndexedDB, solo texto en localStorage
document.getElementById('btn-guardar').addEventListener('click', async function() {
  try {
    const btnGuardar = this;
    setBtnGuardar(btnGuardar, false);

    const nombre = document.getElementById('input-nombre').value.trim();
    const apellidos = document.getElementById('input-apellidos').value.trim();
    if (!nombre || !apellidos) {
      mostrarToast('El nombre y los apellidos son obligatorios', 'aviso');
      setBtnGuardar(btnGuardar, true);
      return;
    }

    // El ID se genera ya para poder usarlo como clave de media
    const pacienteId = pacienteEditandoId || Date.now();

    // Foto de perfil
    const pacienteActualAntes = pacienteEditandoId ? pacientes.find(p => p.id === pacienteEditandoId) : null;
    let fotoRef = pacienteActualAntes?.foto || '';
    if (fotoPendienteBlob) {
      const key = `foto_${pacienteId}`;
      // Revocar URL antigua antes de sobrescribir
      if (urlCache.has(key)) { const old = urlCache.get(key); if (old) URL.revokeObjectURL(old); urlCache.delete(key); }
      await dbPut(key, fotoPendienteBlob); // sobrescribe si ya existía
      fotoRef = `idb:${key}`;
      fotoPendienteBlob = null;
    }

    // Imágenes clínicas
    const imageWrappers = Array.from(document.getElementById('preview-imagenes').querySelectorAll('.img-wrapper'));
    const imagenes = [];
    for (let i = 0; i < imageWrappers.length; i++) {
      const w = imageWrappers[i];
      if (pendingBlobs.has(w)) {
        const key = `img_${pacienteId}_${Date.now()}_${i}`;
        await dbPut(key, pendingBlobs.get(w));
        imagenes.push(`idb:${key}`);
      } else if (w.dataset.ref) {
        imagenes.push(w.dataset.ref); // referencia existente, sin cambios
      }
    }

    // Eliminar de IndexedDB las imágenes que el usuario borró (estaban guardadas pero ya no están en el DOM)
    if (pacienteActualAntes?.imagenes) {
      const keptImageRefs = new Set(imagenes);
      const orphans = pacienteActualAntes.imagenes.filter(r => r?.startsWith('idb:') && !keptImageRefs.has(r));
      await Promise.all(orphans.map(r => { urlCache.delete(r.slice(4)); return dbDelete(r.slice(4)); }));
    }

    // Vídeos
    const videoWrappers = Array.from(document.getElementById('preview-videos').querySelectorAll('.video-wrapper'));
    const videos = [];
    for (let i = 0; i < videoWrappers.length; i++) {
      const w = videoWrappers[i];
      if (pendingBlobs.has(w)) {
        const key = `vid_${pacienteId}_${Date.now()}_${i}`;
        await dbPut(key, pendingBlobs.get(w));
        videos.push(`idb:${key}`);
      } else if (w.dataset.ref) {
        videos.push(w.dataset.ref);
      }
    }

    // Eliminar de IndexedDB los vídeos que el usuario borró
    if (pacienteActualAntes?.videos) {
      const keptVideoRefs = new Set(videos);
      const orphans = pacienteActualAntes.videos.filter(r => r?.startsWith('idb:') && !keptVideoRefs.has(r));
      await Promise.all(orphans.map(r => { urlCache.delete(r.slice(4)); return dbDelete(r.slice(4)); }));
    }

    const itemsTratamientoCheckeados = itemsTratamiento.map((item, idx) => {
      const cb = document.getElementById(`item-${idx}`);
      return cb ? cb.checked : false;
    });

    const datos = {
      nombre, apellidos,
      fechaNacimiento: document.getElementById('input-fecha').value,
      genero: obtenerGenero(),
      foto: fotoRef,
      situacionBasal: document.getElementById('input-situacion-basal').value,
      diagnostico: document.getElementById('input-diagnostico').value,
      tratamiento: document.getElementById('input-tratamiento').value,
      revision: document.getElementById('input-revision').value,
      horaRevision: document.getElementById('input-hora-revision').value,
      notaRevision: document.getElementById('input-nota-revision').value,
      imagenes, videos,
      itemsTratamiento: itemsTratamientoCheckeados,
      medicaciones: medicacionesEnModal,
    };

    if (pacienteEditandoId) {
      const index = pacientes.findIndex(p => p.id === pacienteEditandoId);
      pacientes[index] = {
        ...pacienteActualAntes, ...datos,
        evoluciones: [...(pacienteActualAntes.evoluciones || []), ...evolucionesAñadidas]
      };
    } else {
      pacientes.push({ id: pacienteId, ...datos, evoluciones: evolucionesAñadidas });
    }

    if (!guardarDatos()) {
      setBtnGuardar(btnGuardar, true);
      mostrarToast('❌ No se pudo guardar. Inténtalo de nuevo o haz una copia de seguridad.', 'error', 5000);
      return;
    }

    document.getElementById('buscador').value = '';
    modalModificado = false;
    evolucionesAñadidas = [];
    filtrarYMostrar();
    await cerrarModal();
    if (vistaActual === 'mes' && datos.revision) {
      const nuevaFecha = new Date(datos.revision + 'T12:00:00');
      fechaMes = nuevaFecha;
      diaSeleccionadoMes = datos.revision;
    }
    if (vistaActual) renderVista();
    mostrarToast('✅ Paciente guardado correctamente', 'exito');
    setBtnGuardar(btnGuardar, true);

  } catch (error) {
    console.error('Error al guardar:', error);
    mostrarToast('❌ Error al guardar: ' + error.message, 'error', 5000);
    setBtnGuardar(this, true);
  }
});

document.getElementById('buscador').addEventListener('input', debounce(filtrarYMostrar, 300));

document.getElementById('selector-orden').addEventListener('change', function() {
  ordenActual = this.value;
  filtrarYMostrar();
});

// Exportar — convierte las referencias idb: a base64 para que el JSON sea portable
document.getElementById('btn-exportar').addEventListener('click', async function() {
  try {
    const pacientesExport = [];
    for (const p of pacientes) {
      const pe = { ...p };
      if (pe.foto?.startsWith('idb:')) {
        const blob = await dbGet(pe.foto.slice(4));
        pe.foto = blob ? await blobADataURL(blob) : '';
      }
      if (pe.imagenes) {
        pe.imagenes = await Promise.all(pe.imagenes.map(async ref => {
          if (!ref?.startsWith('idb:')) return ref;
          const blob = await dbGet(ref.slice(4));
          return blob ? await blobADataURL(blob) : null;
        }));
        pe.imagenes = pe.imagenes.filter(Boolean);
      }
      if (pe.videos) {
        pe.videos = await Promise.all(pe.videos.map(async ref => {
          if (!ref?.startsWith('idb:')) return ref;
          const blob = await dbGet(ref.slice(4));
          return blob ? await blobADataURL(blob) : null;
        }));
        pe.videos = pe.videos.filter(Boolean);
      }
      pacientesExport.push(pe);
    }
    const blob = new Blob([JSON.stringify(pacientesExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sauce-copia-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem('ultimoBackup', fechaHoy());
    localStorage.removeItem('backupSnoozed');
    document.getElementById('backup-banner')?.remove();
  } catch (e) {
    mostrarToast('❌ Error al exportar: ' + e.message, 'error', 5000);
  }
});

// Importar — guarda la media del JSON en IndexedDB automáticamente
document.getElementById('input-importar').addEventListener('change', function() {
  if (!this.files[0]) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const datosImportados = JSON.parse(e.target.result);
      if (!Array.isArray(datosImportados)) throw new Error('No es un array');

      let nuevos = 0, saltados = 0, invalidos = 0;

      for (const pacienteImportado of datosImportados) {
        if (!pacienteImportado || typeof pacienteImportado !== 'object' ||
            !pacienteImportado.id || !pacienteImportado.nombre || !pacienteImportado.apellidos) {
          invalidos++; continue;
        }
        if (pacientes.some(p => p.id === pacienteImportado.id)) {
          saltados++; continue;
        }

        // Mover media base64 a IndexedDB
        if (pacienteImportado.foto?.startsWith('data:')) {
          const key = `foto_${pacienteImportado.id}`;
          await dbPut(key, dataURLaBlob(pacienteImportado.foto));
          pacienteImportado.foto = `idb:${key}`;
        }
        if (pacienteImportado.imagenes) {
          for (let i = 0; i < pacienteImportado.imagenes.length; i++) {
            if (pacienteImportado.imagenes[i]?.startsWith('data:')) {
              const key = `img_${pacienteImportado.id}_${i}`;
              await dbPut(key, dataURLaBlob(pacienteImportado.imagenes[i]));
              pacienteImportado.imagenes[i] = `idb:${key}`;
            }
          }
        }
        if (pacienteImportado.videos) {
          for (let i = 0; i < pacienteImportado.videos.length; i++) {
            if (pacienteImportado.videos[i]?.startsWith('data:')) {
              const key = `vid_${pacienteImportado.id}_${i}`;
              await dbPut(key, dataURLaBlob(pacienteImportado.videos[i]));
              pacienteImportado.videos[i] = `idb:${key}`;
            }
          }
        }

        pacientes.push(pacienteImportado);
        nuevos++;
      }

      if (!guardarDatos()) return;
      filtrarYMostrar();

      const msg = document.getElementById('msg-importar');
      msg.style.display = 'block';
      const extraMsg = invalidos > 0 ? ` ${invalidos} registro${invalidos > 1 ? 's' : ''} omitido${invalidos > 1 ? 's' : ''} por datos inválidos.` : '';
      if (nuevos > 0 && saltados > 0) {
        msg.textContent = `✅ ${nuevos} paciente${nuevos > 1 ? 's' : ''} nuevo${nuevos > 1 ? 's' : ''} agregado${nuevos > 1 ? 's' : ''}. ${saltados} ya existían.${extraMsg}`;
      } else if (nuevos > 0) {
        msg.textContent = `✅ ${nuevos} paciente${nuevos > 1 ? 's' : ''} nuevo${nuevos > 1 ? 's' : ''} agregado${nuevos > 1 ? 's' : ''}.${extraMsg}`;
      } else if (saltados > 0) {
        msg.textContent = `ℹ️ Todos los ${saltados} paciente${saltados > 1 ? 's' : ''} ya existían. No se agregó nada.${extraMsg}`;
      } else if (invalidos > 0) {
        msg.textContent = `❌ No se importó nada. ${invalidos} registro${invalidos > 1 ? 's' : ''} con datos inválidos.`;
      }
      setTimeout(() => msg.style.display = 'none', 5000);
    } catch {
      mostrarToast('❌ Error al importar: archivo no válido.', 'error', 5000);
    }
  };
  reader.readAsText(this.files[0]);
});

// ─── CALENDARIO ────────────────────────────────────────────────────────────
document.getElementById('btn-descargar-calendario').addEventListener('click', function() {
  const citasConFecha = pacientes.filter(p => p.revision && p.revision.trim() !== '');
  if (citasConFecha.length === 0) { mostrarToast('No hay citas programadas para exportar.', 'aviso'); return; }

  let ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SAUCE//Historias Clínicas//ES
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:SAUCE - Citas Médicas
X-WR-TIMEZONE:Europe/Madrid
X-WR-CALDESC:Citas de pacientes registradas en SAUCE
`;

  citasConFecha.forEach(p => {
    const fecha = p.revision;
    const hora = p.horaRevision || '09:00';
    const [año, mes, día] = fecha.split('-');
    const [horaNum, minNum] = hora.split(':');
    const dtStart = `${año}${mes}${día}T${horaNum}${minNum}00`;
    const totalMinutos = parseInt(horaNum) * 60 + parseInt(minNum) + 60;
    const horaFin = Math.floor(totalMinutos / 60) % 24;
    const minFin = totalMinutos % 60;
    const dtEnd = `${año}${mes}${día}T${horaFin.toString().padStart(2,'0')}${minFin.toString().padStart(2,'0')}00`;
    const escIcal = t => (t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n').replace(/\r/g, '');

    ics += `BEGIN:VEVENT
UID:sauce-${p.id}@sauce.app
DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z
DTSTART:${dtStart}
DTEND:${dtEnd}
SUMMARY:${escIcal(`${p.nombre} ${p.apellidos} - Revisión médica`)}
DESCRIPTION:${escIcal(`Diagnóstico: ${p.diagnostico || 'No especificado'}\\nTratamiento: ${p.tratamiento || 'No especificado'}`)}
LOCATION:Clínica SAUCE
CATEGORIES:Revisión Médica
STATUS:CONFIRMED
END:VEVENT
`;
  });

  ics += `END:VCALENDAR`;
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sauce-calendario-${new Date().toISOString().split('T')[0]}.ics`;
  a.click();
  URL.revokeObjectURL(url);
  mostrarToast(`✅ Calendario descargado con ${citasConFecha.length} cita${citasConFecha.length > 1 ? 's' : ''}`, 'exito');
});

// ─── CONFIGURACIÓN ITEMS TRATAMIENTO ────────────────────────────────────
function renderListaItems() {
  const cont = document.getElementById('lista-items');
  cont.innerHTML = '';
  const contador = document.getElementById('contador-items');
  if (contador) contador.textContent = itemsTratamiento.length;

  itemsTratamiento.forEach((item) => {
    const card = document.createElement('div');
    card.style.cssText = 'background: var(--white); padding: 12px; border-radius: 8px; border: 1.5px solid var(--border); display: flex; align-items: center; justify-content: space-between;';

    const text = document.createElement('span');
    text.textContent = item;
    text.style.cssText = 'font-size: 14px; flex: 1;';

    const btnEditar = document.createElement('button');
    btnEditar.textContent = '✏️';
    btnEditar.style.cssText = 'background: var(--accent-light); color: var(--accent); border: none; border-radius: 6px; width: 32px; height: 32px; cursor: pointer; font-weight: 700; transition: all 0.15s; margin-right: 6px;';
    btnEditar.addEventListener('click', async () => {
      const nuevoNombre = await mostrarPrompt(`Editar ítem de tratamiento (actual: "${item}")`, item);
      if (nuevoNombre === null) return;
      const nombreTrimmed = nuevoNombre.trim();
      if (!nombreTrimmed) { mostrarToast('El nombre no puede estar vacío', 'aviso'); return; }
      if (nombreTrimmed === item) return;
      if (itemsTratamiento.includes(nombreTrimmed)) { mostrarToast('Este nombre ya existe', 'aviso'); return; }
      itemsTratamiento[itemsTratamiento.indexOf(item)] = nombreTrimmed;
      guardarItems();
      guardarDatos();
      renderListaItems();
      mostrarToast(`✅ '${item}' renombrado a '${nombreTrimmed}'`, 'exito');
    });

    const btnEliminar = document.createElement('button');
    btnEliminar.textContent = '✕';
    btnEliminar.style.cssText = 'background: var(--danger-light); color: var(--danger); border: none; border-radius: 6px; width: 32px; height: 32px; cursor: pointer; font-weight: 700; transition: all 0.15s;';
    btnEliminar.addEventListener('click', () => {
      const idxActual = itemsTratamiento.indexOf(item);
      if (idxActual === -1) return;
      pacientes.forEach(p => {
        if (p.itemsTratamiento?.length > idxActual) p.itemsTratamiento.splice(idxActual, 1);
      });
      itemsTratamiento.splice(idxActual, 1);
      guardarItems();
      guardarDatos();
      renderListaItems();
    });

    card.appendChild(text);
    card.appendChild(btnEditar);
    card.appendChild(btnEliminar);
    cont.appendChild(card);
  });
}

document.getElementById('btn-agregar-item').addEventListener('click', function() {
  const input = document.getElementById('input-nuevo-item');
  const nuevoItem = input.value.trim();
  if (!nuevoItem) { mostrarToast('Por favor escribe un ítem', 'aviso'); return; }
  if (itemsTratamiento.includes(nuevoItem)) { mostrarToast('Este ítem ya existe', 'aviso'); return; }
  itemsTratamiento.push(nuevoItem);
  guardarItems();
  input.value = '';
  renderListaItems();
  mostrarToast(`✅ '${nuevoItem}' añadido a todos los pacientes`, 'exito');
});

// ─── CONFIGURACIÓN CATÁLOGO DE FÁRMACOS ─────────────────────────────────
function renderListaFarmacos() {
  const cont = document.getElementById('lista-farmacos');
  cont.innerHTML = '';
  const contador = document.getElementById('contador-farmacos');
  if (contador) contador.textContent = farmacos.length;

  if (farmacos.length === 0) {
    cont.innerHTML = `<div class="empty-state-mini">Aún no hay fármacos en el catálogo.</div>`;
    return;
  }

  // Cada fármaco se pinta como una tarjeta con sus datos, y un formulario de edición desplegable
  // (mismos campos que al añadir uno nuevo) para poder cambiar cualquier parámetro sin salir de la lista.
  farmacos.forEach((f, idx) => {
    const unidad = unidadLabelFarmaco(f.nombre);
    const porCaja = unidadesPorCajaCatalogo(f);
    const partes = [];
    if (f.concentracionMg > 0) partes.push(`${f.concentracionMg} mg/${unidad.replace(/s$/, '')}`);
    partes.push(porCaja > 0 ? `${porCaja} ${unidad}/caja` : `${unidad}, caja sin definir`);

    const card = document.createElement('div');
    card.className = 'farmaco-card';
    card.innerHTML = `
      <div class="farmaco-card-fila">
        <span class="farmaco-nombre">${esc(f.nombre)}</span>
        <span class="farmaco-caja">${esc(partes.join(' · '))}</span>
        <button type="button" class="btn-icono-editar" data-idx="${idx}" aria-label="Editar fármaco">✏️</button>
        <button type="button" class="btn-icono-eliminar" data-idx="${idx}" aria-label="Eliminar fármaco">✕</button>
      </div>
      <div class="farmaco-card-edit oculto">
        <label class="label-catalogo-farmaco">Nombre del fármaco</label>
        <input type="text" class="input-catalogo-farmaco input-editar-farmaco-nombre" value="${esc(f.nombre)}">
        <div class="fila-3-columnas" style="margin-top: 8px;">
          <div>
            <label class="label-catalogo-farmaco">mg / unidad</label>
            <input type="number" class="input-catalogo-farmaco input-editar-farmaco-concentracion" min="0" step="any" value="${f.concentracionMg || ''}">
          </div>
          <div>
            <label class="label-catalogo-farmaco">Unidad</label>
            <input type="text" class="input-catalogo-farmaco input-editar-farmaco-unidad" value="${esc(f.unidadLabel || 'comprimidos')}">
          </div>
          <div>
            <label class="label-catalogo-farmaco">Unid. / caja</label>
            <input type="number" class="input-catalogo-farmaco input-editar-farmaco-caja" min="0" step="1" value="${porCaja || ''}">
          </div>
        </div>
        <div class="medicacion-form-botones">
          <button type="button" class="btn-secundario btn-cancelar-editar-farmaco">Cancelar</button>
          <button type="button" class="btn-primario btn-guardar-editar-farmaco" data-idx="${idx}">✓ Guardar cambios</button>
        </div>
      </div>
    `;
    cont.appendChild(card);
  });

  // Abrir/cerrar el formulario de edición de un fármaco
  cont.querySelectorAll('.btn-icono-editar').forEach(b => b.addEventListener('click', () => {
    const editDiv = b.closest('.farmaco-card').querySelector('.farmaco-card-edit');
    editDiv.classList.toggle('oculto');
    if (!editDiv.classList.contains('oculto')) editDiv.querySelector('.input-editar-farmaco-nombre').focus();
  }));
  cont.querySelectorAll('.btn-cancelar-editar-farmaco').forEach(b => b.addEventListener('click', () => {
    b.closest('.farmaco-card-edit').classList.add('oculto');
  }));

  // Guardar los cambios de un fármaco: todos sus parámetros (nombre, mg/unidad, unidad, unidades/caja)
  // se pueden modificar aquí y quedan guardados en el propio listado del catálogo.
  cont.querySelectorAll('.btn-guardar-editar-farmaco').forEach(b => b.addEventListener('click', () => {
    const idx = parseInt(b.dataset.idx, 10);
    const f = farmacos[idx];
    if (!f) return;
    const editDiv = b.closest('.farmaco-card-edit');
    const nuevoNombre = editDiv.querySelector('.input-editar-farmaco-nombre').value.trim();
    if (!nuevoNombre) { mostrarToast('El nombre no puede estar vacío', 'aviso'); return; }
    if (nuevoNombre.toLowerCase() !== f.nombre.toLowerCase() && farmacos.some(x => x.nombre.toLowerCase() === nuevoNombre.toLowerCase())) {
      mostrarToast('Ya existe un fármaco con ese nombre', 'aviso'); return;
    }
    const nuevaConc = parseFloat(editDiv.querySelector('.input-editar-farmaco-concentracion').value) || 0;
    const nuevaUnidad = editDiv.querySelector('.input-editar-farmaco-unidad').value.trim() || 'comprimidos';
    const nuevaCaja = parseInt(editDiv.querySelector('.input-editar-farmaco-caja').value, 10) || 0;

    const nombreAnterior = f.nombre;
    f.nombre = nuevoNombre;
    f.concentracionMg = nuevaConc;
    f.unidadLabel = nuevaUnidad;
    f.unidadesPorCaja = nuevaCaja;
    delete f.comprimidosPorCaja; // campo antiguo, ya migrado a unidadesPorCaja

    // Si cambia el nombre, actualiza también las medicaciones ya guardadas que lo referencian
    if (nombreAnterior !== nuevoNombre) {
      let afectados = false;
      pacientes.forEach(p => (p.medicaciones || []).forEach(m => {
        if (m.farmaco === nombreAnterior) { m.farmaco = nuevoNombre; afectados = true; }
      }));
      if (afectados) guardarDatos();
    }

    guardarFarmacos();
    renderListaFarmacos();
    actualizarDatalistFarmacos();
    mostrarToast(`✅ '${nuevoNombre}' actualizado`, 'exito');
  }));

  cont.querySelectorAll('.btn-icono-eliminar').forEach(b => b.addEventListener('click', async () => {
    const idx = parseInt(b.dataset.idx, 10);
    const f = farmacos[idx];
    if (!f) return;
    const ok = await mostrarConfirm(`¿Eliminar "${f.nombre}" del catálogo? Las medicaciones ya registradas con este fármaco no se verán afectadas.`, { textoOk: 'Eliminar', textoCancel: 'Cancelar', peligro: true });
    if (!ok) return;
    farmacos = farmacos.filter(x => x !== f);
    guardarFarmacos();
    renderListaFarmacos();
    actualizarDatalistFarmacos();
  }));
}

document.getElementById('btn-agregar-farmaco').addEventListener('click', function() {
  const nombreInput = document.getElementById('input-nuevo-farmaco-nombre');
  const concInput = document.getElementById('input-nuevo-farmaco-concentracion');
  const unidadInput = document.getElementById('input-nuevo-farmaco-unidad');
  const cajaInput = document.getElementById('input-nuevo-farmaco-caja');
  const nombre = nombreInput.value.trim();
  const concentracionMg = parseFloat(concInput.value) || 0;
  const unidadLabel = unidadInput.value.trim() || 'comprimidos';
  const unidadesPorCaja = parseInt(cajaInput.value, 10) || 0;
  if (!nombre) { mostrarToast('Escribe el nombre del fármaco', 'aviso'); return; }
  if (farmacos.some(f => f.nombre.toLowerCase() === nombre.toLowerCase())) { mostrarToast('Este fármaco ya existe', 'aviso'); return; }
  farmacos.push({ nombre, concentracionMg, unidadLabel, unidadesPorCaja });
  guardarFarmacos();
  nombreInput.value = '';
  concInput.value = '';
  unidadInput.value = '';
  cajaInput.value = '';
  renderListaFarmacos();
  actualizarDatalistFarmacos();
  mostrarToast(`✅ '${nombre}' añadido al catálogo`, 'exito');
});

// ─── RECORDATORIO BACKUP ──────────────────────────────────────────────────────
function mostrarRecordatorioBackup() {
  const hoy = fechaHoy();
  const ultimoBackup = localStorage.getItem('ultimoBackup');
  const snoozedHasta = localStorage.getItem('backupSnoozed');

  // No mostrar si fue snoozed recientemente
  if (snoozedHasta && hoy <= snoozedHasta) return;

  // Primera visita en este origen: registrar hoy como referencia y no molestar
  if (!ultimoBackup) {
    localStorage.setItem('ultimoBackup', hoy);
    return;
  }

  const diasSinBackup = Math.floor((new Date(hoy) - new Date(ultimoBackup)) / 86400000);
  if (diasSinBackup < 7) return;

  const banner = document.createElement('div');
  banner.id = 'backup-banner';
  banner.innerHTML = `
    <span>💾 Se recomienda hacer copia de seguridad</span>
    <button id="backup-banner-cerrar">✕</button>
  `;
  document.body.appendChild(banner);

  document.getElementById('backup-banner-cerrar').addEventListener('click', () => {
    banner.remove();
    localStorage.setItem('backupSnoozed', new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
  });
}

// ─── RESUMEN DE MEDICACIÓN (consumo global, sección Medicación) ──────────────
let vistaResumenMedicacion = 'semana'; // 'semana' | 'mes'
let fechaResumenMedicacion = new Date(); // fecha ancla para la navegación
let filtroAlertasFarmaco = ''; // filtra las alertas de fin de medicación por nombre de fármaco
let filtroAlertasPaciente = ''; // filtra las alertas de fin de medicación por id de paciente

// Rango [inicio, fin] en ISO del periodo actualmente seleccionado (semana lunes-domingo, o mes completo)
function rangoResumenMedicacionActual() {
  if (vistaResumenMedicacion === 'mes') {
    const año = fechaResumenMedicacion.getFullYear();
    const mes = fechaResumenMedicacion.getMonth();
    return {
      inicio: toISO(new Date(año, mes, 1, 12, 0, 0)),
      fin: toISO(new Date(año, mes + 1, 0, 12, 0, 0)),
    };
  }
  const d = new Date(fechaResumenMedicacion);
  const dia = d.getDay();
  const diffLunes = dia === 0 ? -6 : 1 - dia;
  d.setDate(d.getDate() + diffLunes);
  const lunes = new Date(d);
  const domingo = new Date(d);
  domingo.setDate(domingo.getDate() + 6);
  return { inicio: toISO(lunes), fin: toISO(domingo) };
}

function cambiarVistaResumenMedicacion(vista, btn) {
  vistaResumenMedicacion = vista;
  document.querySelectorAll('#seccion-medicacion .vista-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderResumenMedicacion();
}

function navegarResumenMedicacion(delta) {
  if (vistaResumenMedicacion === 'mes') {
    fechaResumenMedicacion.setMonth(fechaResumenMedicacion.getMonth() + delta);
  } else {
    fechaResumenMedicacion.setDate(fechaResumenMedicacion.getDate() + delta * 7);
  }
  renderResumenMedicacion();
}

function irAHoyResumenMedicacion() {
  fechaResumenMedicacion = new Date();
  renderResumenMedicacion();
}

// Medicaciones que terminan dentro del periodo (riesgo de quedarse sin tratamiento),
// y medicaciones "hasta la próxima revisión" cuyo paciente todavía no tiene esa cita fijada.
function calcularAlertasFinMedicacion(inicio, fin) {
  const seQuedanSin = [];
  const sinRevisionFijada = [];
  pacientes.forEach(p => {
    (p.medicaciones || []).forEach(med => {
      if (med.autoFin && !p.revision) {
        sinRevisionFijada.push({ paciente: p, med });
        return;
      }
      const finResuelto = resolverFinMedicacion(med, p.revision);
      if (finResuelto && finResuelto >= inicio && finResuelto <= fin) {
        seQuedanSin.push({ paciente: p, med, fin: finResuelto });
      }
    });
  });
  seQuedanSin.sort((a, b) => a.fin.localeCompare(b.fin));
  return { seQuedanSin, sinRevisionFijada };
}

// Agrupa una lista de alertas (ya filtrada) por fármaco, para que si varios pacientes
// se quedan sin el mismo medicamento salga junto y no disperso en la lista.
// Cada grupo conserva el orden interno que ya traía la lista (por fecha), y los grupos
// se ordenan por la alerta más próxima/urgente de cada uno.
function agruparAlertasPorFarmaco(lista) {
  const grupos = new Map();
  lista.forEach(a => {
    const key = a.med.farmaco || '(sin nombre)';
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(a);
  });
  return [...grupos.entries()].sort((a, b) => {
    const fa = a[1][0].fin || '';
    const fb = b[1][0].fin || '';
    return fa.localeCompare(fb) || a[0].localeCompare(b[0], 'es');
  });
}

function cambiarFiltroAlertasFarmaco(valor) { filtroAlertasFarmaco = valor; renderResumenMedicacion(); }
function cambiarFiltroAlertasPaciente(valor) { filtroAlertasPaciente = valor; renderResumenMedicacion(); }

function renderFiltroAlertasMedicacion(todasLasAlertas) {
  const filtroCont = document.getElementById('filtro-alertas-medicacion');
  if (!filtroCont) return;

  if (todasLasAlertas.length === 0) { filtroCont.innerHTML = ''; return; }

  const farmacosPresentes = [...new Set(todasLasAlertas.map(a => a.med.farmaco || '(sin nombre)'))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  const pacientesPresentes = [...new Map(todasLasAlertas.map(a => [a.paciente.id, `${a.paciente.nombre} ${a.paciente.apellidos}`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'es'));

  // Si la selección actual ya no aparece en este periodo, se resetea para no dejar un filtro "vacío" invisible.
  if (filtroAlertasFarmaco && !farmacosPresentes.includes(filtroAlertasFarmaco)) filtroAlertasFarmaco = '';
  if (filtroAlertasPaciente && !pacientesPresentes.some(([id]) => String(id) === String(filtroAlertasPaciente))) filtroAlertasPaciente = '';

  // Los desplegables solo aparecen si de verdad hay algo que filtrar (más de una opción).
  if (farmacosPresentes.length <= 1 && pacientesPresentes.length <= 1) { filtroCont.innerHTML = ''; return; }

  filtroCont.innerHTML = `
    <select id="select-filtro-alertas-farmaco" class="filtro-alertas-select" aria-label="Filtrar alertas por fármaco">
      <option value="">💊 Todos los fármacos</option>
      ${farmacosPresentes.map(f => `<option value="${esc(f)}" ${f === filtroAlertasFarmaco ? 'selected' : ''}>${esc(f)}</option>`).join('')}
    </select>
    <select id="select-filtro-alertas-paciente" class="filtro-alertas-select" aria-label="Filtrar alertas por paciente">
      <option value="">🧑 Todos los pacientes</option>
      ${pacientesPresentes.map(([id, nom]) => `<option value="${id}" ${String(id) === String(filtroAlertasPaciente) ? 'selected' : ''}>${esc(nom)}</option>`).join('')}
    </select>
    ${(filtroAlertasFarmaco || filtroAlertasPaciente) ? `<button type="button" id="btn-limpiar-filtro-alertas" class="btn-limpiar-filtro-alertas">✕ Quitar filtro</button>` : ''}
  `;
  document.getElementById('select-filtro-alertas-farmaco').addEventListener('change', function() { cambiarFiltroAlertasFarmaco(this.value); });
  document.getElementById('select-filtro-alertas-paciente').addEventListener('change', function() { cambiarFiltroAlertasPaciente(this.value); });
  const btnLimpiar = document.getElementById('btn-limpiar-filtro-alertas');
  if (btnLimpiar) btnLimpiar.addEventListener('click', () => { filtroAlertasFarmaco = ''; filtroAlertasPaciente = ''; renderResumenMedicacion(); });
}

function renderAlertasFinMedicacion(inicio, fin) {
  const cont = document.getElementById('alertas-fin-medicacion');
  if (!cont) return;
  const { seQuedanSin, sinRevisionFijada } = calcularAlertasFinMedicacion(inicio, fin);
  const todasLasAlertas = [...seQuedanSin, ...sinRevisionFijada];

  renderFiltroAlertasMedicacion(todasLasAlertas);

  if (todasLasAlertas.length === 0) { cont.innerHTML = ''; return; }

  const pasaFiltro = a => {
    if (filtroAlertasFarmaco && (a.med.farmaco || '(sin nombre)') !== filtroAlertasFarmaco) return false;
    if (filtroAlertasPaciente && String(a.paciente.id) !== String(filtroAlertasPaciente)) return false;
    return true;
  };
  const seQuedanSinF = seQuedanSin.filter(pasaFiltro);
  const sinRevisionFijadaF = sinRevisionFijada.filter(pasaFiltro);

  if (seQuedanSinF.length === 0 && sinRevisionFijadaF.length === 0) {
    cont.innerHTML = `<div class="empty-state-mini">No hay alertas de este fármaco/paciente en este periodo.</div>`;
    return;
  }
  const hoy = fechaHoy();

  const filaAlerta = (a, textoFecha) => `
    <div class="alerta-medicacion-fila" role="button" tabindex="0" data-id="${a.paciente.id}">
      <span class="alerta-medicacion-paciente">${esc(a.paciente.nombre)} ${esc(a.paciente.apellidos)}</span>
      <span class="alerta-medicacion-fecha">${textoFecha}</span>
    </div>`;

  // Agrupa por fármaco para que, si varias personas se quedan sin el mismo medicamento,
  // se vea de un vistazo en vez de perderse entre filas sueltas de pacientes distintos.
  const renderBloqueAgrupado = (lista, formatearTexto) => agruparAlertasPorFarmaco(lista).map(([farmaco, alertas]) => `
    <div class="alerta-medicacion-grupo">
      <div class="alerta-medicacion-grupo-titulo">
        💊 ${esc(farmaco)}
        ${alertas.length > 1 ? `<span class="alerta-medicacion-grupo-badge">${alertas.length} pacientes</span>` : ''}
      </div>
      ${alertas.map(a => filaAlerta(a, formatearTexto(a))).join('')}
    </div>
  `).join('');

  let html = '';
  if (seQuedanSinF.length > 0) {
    html += `
      <div class="alerta-medicacion-bloque alerta-medicacion-bloque-urgente">
        <div class="alerta-medicacion-titulo">⚠️ Se quedan sin medicación en este periodo</div>
        ${renderBloqueAgrupado(seQuedanSinF, a => `${a.fin <= hoy ? 'terminó' : 'termina'} el ${formatearFecha(a.fin)}`)}
      </div>`;
  }
  if (sinRevisionFijadaF.length > 0) {
    html += `
      <div class="alerta-medicacion-bloque">
        <div class="alerta-medicacion-titulo">🗓️ Dependen de una revisión todavía sin fecha</div>
        ${renderBloqueAgrupado(sinRevisionFijadaF, () => 'agenda su próxima revisión')}
      </div>`;
  }
  cont.innerHTML = html;
  cont.querySelectorAll('.alerta-medicacion-fila').forEach(el => {
    const abrir = () => abrirModal(parseInt(el.dataset.id, 10));
    el.addEventListener('click', abrir);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  });
}

function renderResumenMedicacion() {
  const cont = document.getElementById('resumen-medicacion-resultado');
  if (!cont) return;

  const { inicio, fin } = rangoResumenMedicacionActual();

  const label = document.getElementById('label-resumen-medicacion');
  if (label) {
    label.textContent = vistaResumenMedicacion === 'mes'
      ? `${MESES[fechaResumenMedicacion.getMonth()]} ${fechaResumenMedicacion.getFullYear()}`
      : `${formatearFecha(inicio)} – ${formatearFecha(fin)}`;
  }

  renderAlertasFinMedicacion(inicio, fin);

  // Agrupa por fármaco: comprimidos totales y comprimidos por paciente (para el desglose)
  const porFarmaco = new Map();
  pacientes.forEach(p => {
    (p.medicaciones || []).forEach(med => {
      const comp = comprimidosEnRango(med, p.revision, inicio, fin);
      if (comp <= 0) return;
      const key = med.farmaco || '(sin nombre)';
      if (!porFarmaco.has(key)) porFarmaco.set(key, { comprimidos: 0, pacientes: new Map() });
      const entry = porFarmaco.get(key);
      entry.comprimidos += comp;
      entry.pacientes.set(p.id, (entry.pacientes.get(p.id) || 0) + comp);
    });
  });

  if (porFarmaco.size === 0) {
    cont.innerHTML = `<div class="empty-state"><div class="empty-icon">💊</div><p>No hay medicación registrada en este periodo.</p></div>`;
    return;
  }

  // El total general solo puede sumar cajas (unidad común a todos los fármacos); sumar
  // unidades sueltas no tendría sentido si mezclan comprimidos, cápsulas y ml.
  let totalCajasGeneral = 0;
  let faltaAlgunaCaja = false;

  const filas = [...porFarmaco.entries()]
    .sort((a, b) => b[1].comprimidos - a[1].comprimidos)
    .map(([nombre, info]) => {
      const unidad = unidadLabelFarmaco(nombre);
      const cajas = cajasNecesarias(nombre, info.comprimidos);
      if (cajas !== null) totalCajasGeneral += cajas; else faltaAlgunaCaja = true;

      const detallePacientes = [...info.pacientes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([pid, cantidad]) => {
          const pac = pacientes.find(x => x.id === pid);
          const nombrePac = pac ? `${pac.nombre} ${pac.apellidos}` : 'Paciente eliminado';
          return `<div class="resumen-medicacion-paciente">${esc(nombrePac)} — ${cantidad} ${esc(unidad)}</div>`;
        }).join('');

      return `
        <details class="resumen-medicacion-card">
          <summary>
            <span class="resumen-medicacion-nombre">💊 ${esc(nombre)}</span>
            <span class="resumen-medicacion-cifras">${info.pacientes.size} paciente${info.pacientes.size !== 1 ? 's' : ''} · ${info.comprimidos} ${esc(unidad)}${cajas !== null ? ` · ${cajas} caja${cajas !== 1 ? 's' : ''}` : ''}</span>
          </summary>
          <div class="resumen-medicacion-pacientes">${detallePacientes}</div>
          ${cajas === null ? '<div class="resumen-medicacion-aviso">⚠️ Añade "unidades por caja" en Configuración → Catálogo de Fármacos para calcular las cajas de este fármaco.</div>' : ''}
        </details>
      `;
    }).join('');

  const totalFarmacos = porFarmaco.size;
  cont.innerHTML = `
    <div class="resumen-medicacion-total">
      <span>Total del periodo (${formatearFecha(inicio)} – ${formatearFecha(fin)}) — ${totalFarmacos} fármaco${totalFarmacos !== 1 ? 's' : ''}</span>
      <strong>${totalCajasGeneral > 0 ? `${totalCajasGeneral} caja${totalCajasGeneral !== 1 ? 's' : ''} en total` : 'define "unidades por caja" para ver el total de cajas'}${faltaAlgunaCaja && totalCajasGeneral > 0 ? ' (+ otros sin caja definida)' : ''}</strong>
    </div>
    ${filas}
  `;
}

// ─── INICIALIZACIÓN ───────────────────────────────────────────────────────────
async function init() {
  try {
    await initDB();
    await migrarAIndexedDB(); // convierte base64 legacy a IndexedDB si es necesario
  } catch (e) {
    // IndexedDB no disponible (Safari modo privado, o error de permisos)
    console.warn('IndexedDB no disponible:', e);
  }
  renderListaItems();
  renderListaFarmacos();
  // Ambos listados empiezan desplegados solo si son cortos; con muchos ya definidos
  // arrancan colapsados para no ocupar toda la pantalla de Ajustes. Una vez el usuario
  // los abre/cierra a mano, ese estado se respeta entre re-renders (no se vuelve a tocar aquí).
  const desplegableItems = document.getElementById('desplegable-items');
  if (desplegableItems) desplegableItems.open = itemsTratamiento.length <= 4;
  const desplegableFarmacos = document.getElementById('desplegable-farmacos');
  if (desplegableFarmacos) desplegableFarmacos.open = farmacos.length <= 4;
  mostrarInfoAlmacenamiento();
  filtrarYMostrar();
  setTimeout(mostrarRecordatorioBackup, 2000);

  // Swipe horizontal entre pestañas del modal
  const modalContenido = document.querySelector('.modal-contenido');
  let touchStartX = 0, touchStartY = 0;
  modalContenido.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  modalContenido.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Solo si swipe horizontal dominante y suficientemente largo
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) {
      const tabs = document.querySelectorAll('.subtab-btn');
      const activeIdx = Array.from(tabs).findIndex(t => t.classList.contains('active'));
      if (dx < 0 && activeIdx < tabs.length - 1) {
        cambiarSubtab(activeIdx + 1, tabs[activeIdx + 1]);
      } else if (dx > 0 && activeIdx > 0) {
        cambiarSubtab(activeIdx - 1, tabs[activeIdx - 1]);
      }
    }
  }, { passive: true });
}

init();
