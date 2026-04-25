# UML Diagrams for Thesis (Movie-Rec)

This folder contains generated UML diagrams for the thesis:

- `use_case_movie_rec.puml`
- `class_diagram_movie_rec.puml`
- `use_case_movie_rec.svg` (optional, rendered)
- `class_diagram_movie_rec.svg` (optional, rendered)
- `class_diagram_ea_style.svg` (pure Python SVG generator, EA-like layered layout)

## Generate files

```powershell
cd D:\APP\movie-rec
python .\reports\uml\generate_uml.py
```

## Generate + render SVG

```powershell
cd D:\APP\movie-rec
python .\reports\uml\generate_uml.py --render
```

The `--render` flag uses the Kroki API to render PlantUML into SVG.

## Generate EA-style class diagram (no PlantUML, no Graphviz)

```powershell
cd D:\APP\movie-rec
python .\reports\uml\generate_ea_style_class_diagram.py
```

## Where to place in thesis

- Use Case Diagram: chapter `3.3 Actori si scenarii de utilizare (Use Case)`
- Class Diagram: chapter `3.5 Proiectarea modelului de date si a fluxurilor de sincronizare`
