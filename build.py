"""Build the paper homepage and offline demo with Python's standard library."""
import argparse
import re
from pathlib import Path


def build_demo():
    source = Path(__file__).resolve().parent / "src"
    document = (source / "page-template.html").read_text(encoding="utf-8")
    interface = (source / "interface.html").read_text(encoding="utf-8")
    interface = interface.replace("__DEMO_REFERENCE_STUDY__", (source / "reference-study.html").read_text(encoding="utf-8"))
    # The exported template already loads the chart dependency after the footer.
    interface = re.sub(r'\s*<script src="https://cdn\.jsdelivr\.net/npm/d3@7\.9\.0/dist/d3\.min\.js"></script>\s*$', "", interface)
    interface = interface.replace('<div id="power-response-demo">', '<main id="power-response-demo">', 1)
    interface = interface.replace('<div role="alert" id="pr-error" hidden></div>\n</div>', '<div role="alert" id="pr-error" hidden></div>\n</main>', 1)
    if not interface.rstrip().endswith("</main>"):
        raise ValueError("The interface must have one complete main element")
    replacements = {
        "__DEMO_SHELL_CSS__": (source / "site-shell.css").read_text(encoding="utf-8") + "\n" + (source / "equipment.css").read_text(encoding="utf-8"),
        "__DEMO_HEADER__": (source / "demo-header.html").read_text(encoding="utf-8"),
        "__DEMO_FOOTER__": (source / "site-footer.html").read_text(encoding="utf-8"),
        "__DEMO_INTERFACE_HTML__": interface,
        "__DEMO_RESPONSES_JS__": ((source / "response-controller.js").read_text(encoding="utf-8") + "\n" + (source / "online-predsls.js").read_text(encoding="utf-8")).replace("</script", "<\\/script"),
        "__DEMO_SIMULATION_JS__": (source / "simulation.js").read_text(encoding="utf-8").replace("</script", "<\\/script"),
        "__DEMO_EQUIPMENT_JS__": (source / "equipment.js").read_text(encoding="utf-8").replace("</script", "<\\/script"),
        "__DEMO_TOPOLOGY_JS__": (source / "topology-timeline.js").read_text(encoding="utf-8").replace("</script", "<\\/script"),
        "__DEMO_INTERFACE_JS__": (source / "interface.js").read_text(encoding="utf-8").replace("</script", "<\\/script"),
    }
    for marker, content in replacements.items():
        if document.count(marker) != 1:
            raise ValueError("Missing or repeated template marker " + marker)
        document = document.replace(marker, content, 1)
    if re.search(r"__DEMO_[A-Z_]+__|__SOURCE_URL__", document):
        raise ValueError("An unresolved template marker remains")
    return document


def build():
    """Return the static paper homepage; it never loads the simulation."""
    source = Path(__file__).resolve().parent / "src"
    document = (source / "landing-template.html").read_text(encoding="utf-8")
    replacements = {
        "__PAPER_SHELL_CSS__": (source / "site-shell.css").read_text(encoding="utf-8"),
        "__PAPER_HEADER__": (source / "site-header.html").read_text(encoding="utf-8"),
        "__PAPER_OVERVIEW__": (source / "method-overview.html").read_text(encoding="utf-8"),
    }
    for marker, content in replacements.items():
        if document.count(marker) != 1:
            raise ValueError("Missing or repeated template marker " + marker)
        document = document.replace(marker, content, 1)
    if re.search(r"__PAPER_[A-Z_]+__|__SOURCE_URL__", document):
        raise ValueError("An unresolved homepage marker remains")
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "index.html")
    parser.add_argument("--demo-output", type=Path, help="Demo output; defaults to demo.html beside the homepage")
    args = parser.parse_args()
    demo_output = args.demo_output or args.output.with_name("demo.html")
    if args.output.resolve() == demo_output.resolve():
        parser.error("Homepage and demo must have different output paths")
    homepage = build()
    demo = build_demo()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    demo_output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(homepage, encoding="utf-8")
    demo_output.write_text(demo, encoding="utf-8")
    print(args.output)
    print(demo_output)
