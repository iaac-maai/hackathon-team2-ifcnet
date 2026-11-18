"""Hello-world model server (test deploy on Render).

Checks that Gradio, IfcOpenShell and ONNX Runtime install and run on Render.
Upload one .ifc file: the server lists how many elements of each IFC class it has.
P3 replaces this file with the real graph-model server.
"""
import os
from collections import Counter

import gradio as gr
import ifcopenshell
import onnxruntime


def describe_ifc(path):
    if path is None:
        return {"status": "ok", "ifcopenshell": ifcopenshell.version, "onnxruntime": onnxruntime.__version__}
    model = ifcopenshell.open(path)
    counts = Counter(p.is_a() for p in model.by_type("IfcProduct"))
    return {"schema": model.schema, "elements": dict(counts.most_common())}


demo = gr.Interface(
    fn=describe_ifc,
    inputs=gr.File(label="IFC file", file_types=[".ifc"], type="filepath"),
    outputs=gr.JSON(label="result"),
    title="Team 2 - IFC model server (hello world)",
    description="Test deploy. Upload an .ifc file to count its elements by class.",
    api_name="predict",
)

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=int(os.environ.get("PORT", 7860)))
