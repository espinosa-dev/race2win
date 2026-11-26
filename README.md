# Race2Win

MVP de un juego arcade de carreras 3D para navegador. Compite contra bots o juega con otras personas en una red local.

## Requisitos

- Node.js 18 o posterior.
- Un navegador moderno compatible con WebGL.

## Instalación y ejecución

```powershell
npm install
npm start
```

Abre [http://localhost:3000](http://localhost:3000). Para jugar por red local, los demás participantes deben abrir la dirección de red que muestra el servidor al arrancar, por ejemplo `http://192.168.1.10:3000`. Todos los equipos deben estar en la misma red; el cortafuegos del anfitrión debe permitir conexiones a Node.js en redes privadas.

La primera persona que entra crea la sala, elige el circuito, el aforo (hasta ocho participantes) y si los huecos libres se completan con bots. Los jugadores humanos que entren sustituyen bots mientras la sala siga abierta.

## Controles

| Tecla | Acción |
| --- | --- |
| `W` o `↑` | Acelerar |
| `S` o `↓` | Frenar; mantener al detenerse para marcha atrás |
| `A`/`D` o `←`/`→` | Girar |
| `C` | Cambiar entre cámara arcade, panorámica y capó |
| `Esc` | Pausar (en multijugador, solo abre el menú local) |
| Pantalla táctil | Pedales y dirección en pantalla |

## Funciones actuales

- Cuatro circuitos 3D: Monaco, Monza, Tokyo Night y Sahara Rally. Sus rutas Catmull-Rom se generan en servidor y cliente desde una geometría compartida.
- Bordes de pista y escapatorias sin estrangulamientos ni cruces, con colisión alineada a las barreras visibles.
- Selector de clima y hora: soleado, atardecer, noche con faros y lluvia con asfalto húmedo y menor agarre.
- Carreras LAN de hasta ocho participantes, parrilla con bots configurables, dificultad de IA y estado «Listo».
- Contrarreloj individual con récords por circuito y fantasma persistente.
- Físicas arcade con marcha atrás, derrape controlable, escapatorias transitables y colisiones entre coches en carreras.
- Límite físico del mapa y de la simulación.
- Selector de cámara, controles táctiles, etiquetas de pilotos, indicadores de DRS y menús de pausa.
- Posiciones en directo, cronómetro, tiempos de llegada y diferencias.
- Detección de vuelta y meta al cruzar la línea en el sentido correcto.
- Cuentas locales con contraseñas derivadas mediante scrypt, sesiones aleatorias persistentes, 500 RC iniciales y datos en `data/accounts.json` y `data/sessions.json`.
- Tienda e inventario validados por el servidor, con puntos, RaceCoins y logros.
- Paddock por pasos con selector amplio de circuito/clima, escaparate 3D, configuración de carrera, estadísticas y Top 10 global.
- Catálogo compartido en `public/catalog.json` y cosméticos visibles en coches de jugadores y bots.
- Récords y trazas de fantasma en `data/records.json`; las cuentas, sesiones y récords locales están excluidos de Git.
- Escena Three.js temática con sombras, parrilla, meta, decoración y coches personalizables.

Las cuentas y sesiones están diseñadas para el servidor LAN local. Las contraseñas se almacenan derivadas con salt; la comunicación HTTP de una LAN no cifra el tráfico, por lo que redes no confiables requieren HTTPS antes de exponer el servidor.

## Pruebas

```powershell
npm test
```

## Estructura

- `server.js`: servidor, simulación de carrera y comunicación en tiempo real.
- `storage.js`: cuentas, sesiones y persistencia local.
- `public/`: interfaz y escena 3D del juego.
- `public/catalog.json`: catálogo compartido de cosméticos y artículos.
- `public/track-geometry.js`: bordes de pista seguros y compartidos entre servidor, cliente y pruebas.
- `tests/`: pruebas del servidor.
