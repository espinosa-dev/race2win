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

## MVP actual

- Circuitos 3D inspirados en Monaco y Monza, con anchura adaptativa en curvas y minimapa en directo.
- Bots y multijugador en red local.
- Límite físico del mapa y de la simulación.
- Vallado alrededor del circuito y colisiones entre coches.
- Posiciones en directo, cronómetro, tiempos de llegada y diferencias.
- Detección de vuelta y meta al cruzar la línea en el sentido correcto.
- Cuentas locales con contraseñas derivadas mediante scrypt, sesiones aleatorias persistentes, 500 RC iniciales y datos en `data/accounts.json` y `data/sessions.json`.
- Tienda e inventario validados por el servidor, con puntos y RC por carrera.
- Paddock con escaparate 3D del coche, selección visual de circuitos, estadísticas del piloto y clasificación global Top 10.
- Catálogo compartido en `public/catalog.json` y cosméticos visibles en coches de jugadores y bots.
- Escena Three.js con sombras, pianos, parrilla, meta, decoración de circuito y coches personalizables.

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
