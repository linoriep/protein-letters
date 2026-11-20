# Protein Letters

Find letter-shaped views in protein structures, write words with A–Z protein shapes, or draw a molecule and turn it into protein artwork.

The public site is static and all artwork and new scanning run in your browser. Saved views cover 1,500 public PDB entries. To scan a new structure, enter a PDB ID or choose a PDB/mmCIF file. ID searches may download the public structure from RCSB. Files you select, SMILES, and molecular sketches stay in your browser. Browser scanning samples 192 coarse and 32 refined rotations per protein unit using the synthetic letter CNN. Its results can differ from the saved library, which used a denser rotation search. Visual resemblance scores are not probabilities.

In Molecule Studio, draw atoms and bonds or load a SMILES string, then create PNG or SVG artwork. The editor checks chemistry with RDKit.js. Artwork with explicit stereochemistry or radical electrons is unavailable. Assembled letters are labeled. The default L is a view of 4OX0 chain A.

Serve this directory over HTTP or HTTPS. The public site is hosted on GitHub Pages from the root of the main branch.

## Sources and dependencies

Rendered traces come from public Protein Data Bank entries. Each source card identifies its PDB entry, where the original structure authors and citations can be found. The bond artwork uses 2WCD chain G. See the [RCSB PDB usage policy](https://www.rcsb.org/pages/usage-policy).

RDKit.js 2026.9.2 is distributed under its [BSD license](vendor/rdkit/LICENSE.txt). TensorFlow.js and its WASM backend 4.22.0 are distributed under the [Apache 2.0 license](vendor/tfjs/tfjs-LICENSE). The letter model was trained on synthetic character images.
