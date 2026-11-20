from _core import *  # core-import


def run(ctx):
    cfg = recipe_config(ctx)
    return process(ctx, fetch_table(cfg["source"]["url"], cfg))
