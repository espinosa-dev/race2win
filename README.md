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

- Circuitos 3D inspirados en Monaco y Monza, de tres vueltas.
- Bots y multijugador en red local.
- Límite físico del mapa y de la simulación.
- Vallado alrededor del circuito y colisiones entre coches.
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
