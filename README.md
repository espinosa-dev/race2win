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

La primera persona que entra crea la sala, elige cuántos bots añadir e inicia la carrera. Hasta ocho pilotos humanos pueden unirse antes de que empiece.

## Controles

| Tecla | Acción |
| --- | --- |
| `W` o `↑` | Acelerar |
| `S` o `↓` | Frenar |
| `A`/`D` o `←`/`→` | Girar |

## MVP actual

- Circuito 3D original de tres vueltas.
- Bots y multijugador en red local.
- Posiciones en directo, cronómetro, tiempos de llegada y diferencias.
- Detección de vuelta y meta al cruzar la línea en el sentido correcto.
- Coches y texturas generados para este proyecto.

El multijugador por Internet, más circuitos, selección de vehículos y una física más avanzada quedan para futuras iteraciones.

## Pruebas

```powershell
npm test
```

## Estructura

- `server.js`: servidor, simulación de carrera y comunicación en tiempo real.
- `public/`: interfaz y escena 3D del juego.
- `tests/`: pruebas del servidor.
