#!/usr/bin/env python3
"""Dependency-free smoke tests for the vnc-login research-access decision layer."""
import importlib.util
import sys
import types
from pathlib import Path


class FakePage:
    def __init__(self, url, content):
        self.url = url
        self._content = content

    def content(self):
        return self._content


def load_module():
    playwright = types.ModuleType("playwright")
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: None
    playwright.sync_api = sync_api
    sys.modules["playwright"] = playwright
    sys.modules["playwright.sync_api"] = sync_api

    path = Path(__file__).with_name("vnc-login.py")
    spec = importlib.util.spec_from_file_location("vnc_login", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    module = load_module()
    assert module.research_access_state(FakePage(
        "https://www.ebay.com/sh/research", "research results"
    )) == "ready"
    assert module.research_access_state(FakePage(
        "https://www.ebay.com/captcha", "captcha"
    )) == "solvable_challenge"
    assert module.research_access_state(FakePage(
        "https://www.ebay.com/sh/research", "security measure"
    )) == "hard_challenge"

    page = FakePage("https://www.ebay.com/captcha", "captcha")
    states = iter(["https://www.ebay.com/captcha", "https://www.ebay.com/sh/research"])
    page_urls = iter(states)
    page.url = next(page_urls)

    def advance(_):
        page.url = next(page_urls)
        page._content = "research results"

    assert module.wait_for_research_access(page, sleep=advance, max_attempts=2) == "ready"
    print("vnc-login flow smoke tests passed")


if __name__ == "__main__":
    main()