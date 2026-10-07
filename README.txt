AZ cache status: True
AZ SSL verification: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
scrape_state verify: True
Site init SSL verification status: True
<function system at 0x7fb574ef2520> found
scrape_state verify: True
Site init SSL verification status: True
scraped 30 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  DC  MissingSchema: Invalid URL '/page/rapid-response': No scheme supplied. Perhaps you meant https:///page/rapid-response?
  FL  IndexError: list index out of range
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#a9cdc5c0db87dec6dbc2cfc6dbcacc87cdccdfccc5c6d9e9c1c8dec8c0c087cec6df': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#a9cdc5c0db87de
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site address'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  OR  ConnectionError: HTTPSConnectionPool(host='ccwd.hecc.oregon.gov', port=443): Max retries exceeded with url: /Layoff/WARN/Download (Caused by NameResolutionError("HTTPSConnection(host='ccwd.hecc.oregon.gov', port=443):
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 30 feeds to /home/runner/work/_temp/warn/warn_feeds.json
