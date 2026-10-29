# Dirección visual · iteración 1

Notas breves de diseño (reversibles). La fuente de verdad visual es el prototipo en `../deliverables/`.

## Idea central
**«Tu lugar»**: MainSpot es el lugar de tu negocio en internet. La identidad toma la arquitectura mexicana de planos de color (muros rosa, sol ocre, sombras lila, cal blanca) y la reduce a geometría tranquila. La marca es un **punto** (el *spot*): aparece como logotipo y como indicador del estado de la página.

## Paleta
| Token | Hex | Uso |
|---|---|---|
| `--cal` | `#F4F2F6` | Fondo general (cal con matiz lila, no crema) |
| `--ink` | `#221A33` | Texto principal, botón oscuro, foco |
| `--ink-2` | `#5B5470` | Texto secundario (7.1:1 sobre blanco) |
| `--rosa` | `#D3006B` | Acción principal y «te toca decidir» (5.3:1 con blanco) |
| `--ocre` | `#F2B134` | Proceso en curso, prueba gratis, decoración |
| `--nopal` | `#1E7A4C` | Página en internet / éxito (5.3:1) |
| `--alerta` | `#B42318` | Errores (6.6:1) |

Rosa ≠ rojo: el rosa nunca comunica error; siempre va acompañado de texto.

## Tipografía
- **Bricolage Grotesque** (títulos): personalidad, ejes de tamaño óptico y ancho.
- **Atkinson Hyperlegible Next** (texto e interfaz): diseñada para máxima legibilidad; base 17 px por el público de edades variadas.

## Reglas
1. Una acción principal por vista (botón rosa). El resto: secundario oscuro con contorno o enlace.
2. Superficies planas: blanco sobre cal, borde de 1 px; sombras solo para hojas y diálogos.
3. Radios por jerarquía: hoja 28 · tarjeta 20 · control 14 · chip redondo.
4. Sin mayúsculas sostenidas en etiquetas, sin flechas en botones, sin tipografía monoespaciada.
5. El estado nunca depende solo del color: punto + texto + icono.
6. Movimiento solo como respuesta a una acción; `prefers-reduced-motion` lo elimina.

## Layout
- Móvil: barra superior (marca + avisos) · contenido en una columna · navegación inferior de 4 destinos.
- Escritorio ≥1024: barra lateral + columna principal (máx. 720 px). ≥1280: chat de Telegram simulado a la derecha, para mostrar que panel y chat son la misma experiencia.
- Alta e invitación: pantalla dividida con la composición de planos de color (el único momento «escénico»).
