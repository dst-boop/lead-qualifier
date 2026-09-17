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
<function system at 0x7f4ae1a407c0> found
scrape_state verify: True
Site init SSL verification status: True
scraped 30 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  AL  ConnectTimeout: HTTPSConnectionPool(host='www.madeinalabama.com', port=443): Max retries exceeded with url: /warn-list/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.madeinalabama.com', port=443) at 0x7f4
  CO  KeyError: 'CO Notifications'
  FL  IndexError: list index out of range
  GA  ConnectTimeout: HTTPSConnectionPool(host='www.tcsg.edu', port=443): Max retries exceeded with url: /warn-public-view/entry/80515/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.tcsg.edu', port=443) at 0x7f
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#a7c3cbced589d0c8d5ccc1c8d5c4c289c3c2d1c2cbc8d7e7cfc6d0c6cece89c0c8d1': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#a7c3cbced589d0
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site address'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 30 feeds to /home/runner/work/_temp/warn/warn_feeds.json
