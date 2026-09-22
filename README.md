# SAUCE

Progressive Web App de gestión de historiales clínicos para una ONG médica que opera en Camboya. En uso real sobre el terreno.

🔗 **Demo:** [sauce2.netlify.app](https://sauce2.netlify.app)

---

## El problema

El equipo médico trabaja en zonas con conectividad intermitente y llevaba el seguimiento de pacientes en papel y hojas de cálculo sueltas. Necesitaban algo que funcionase sin conexión, desde el móvil, y que no exigiese formación técnica para usarlo.

## La solución

Una PWA instalable que funciona completamente offline, guarda los datos en el propio dispositivo y cubre el circuito entero: ficha del paciente, agenda de citas y control de medicación.

### Funcionalidades

**Pacientes**
- Ficha con datos personales, diagnóstico principal e historia clínica
- Evolutivos con notas fechadas
- Adjuntos de pruebas, imágenes y vídeos, con visor modal y compresión automática de imágenes
- Buscador y ordenación del listado

**Agenda**
- Vistas de día, semana y mes
- Próximas citas y revisiones por paciente
- Exportación del calendario

**Medicación**
- Catálogo de fármacos editable desde la propia app
- Pauta por paciente: dosis, comprimidos por toma, fechas de inicio y fin
- Alertas automáticas de fin de tratamiento, con filtro y resumen por semana o mes

**Configuración y datos**
- Ítems y checklists configurables sin tocar código, para adaptar la app a cada protocolo
- Exportación de copia de seguridad completa

## Stack

| | |
|---|---|
| Frontend | HTML, CSS y JavaScript vanilla, sin frameworks ni build |
| Persistencia | `localStorage` |
| Offline | Service Worker + Web App Manifest |
| Deploy | Netlify |

Decidí no usar framework a propósito: la app tenía que cargar rápido con conexiones malas, funcionar en móviles modestos y poder ser mantenida por alguien que no conozca React.

## Cómo ejecutarlo en local

```bash
git clone https://github.com/<tu-usuario>/sauce.git
cd sauce
npx serve .
```

Abrir `http://localhost:3000`. No hay dependencias ni paso de compilación.

## Aprendizajes

- Diseñar **offline-first** cambia toda la arquitectura: el estado local es la fuente de verdad, no una caché
- Iterar con una doctora voluntaria como usuaria real obligó a rehacer decisiones que sobre el papel parecían correctas
- La compresión de imágenes en cliente fue la mejora con más impacto en el uso diario
- Hacer configurables los checklists y el catálogo de fármacos eliminó la dependencia de mí para cada cambio de protocolo

## Siguiente versión

Versión multi-tenant para que otras organizaciones puedan usarla:

- Migración a base de datos en la nube (Supabase / Firebase)
- Autenticación de usuarios
- Permisos por rol: médico, coordinador, administrador

---

> Este repositorio contiene únicamente el código de la aplicación. No incluye datos de pacientes ni información clínica real.
