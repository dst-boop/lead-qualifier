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
<function system at 0x7ffa044bdf80> found
scrape_state verify: True
Site init SSL verification status: True
scraped 29 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  AL  ConnectTimeout: HTTPSConnectionPool(host='www.madeinalabama.com', port=443): Max retries exceeded with url: /warn-list/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.madeinalabama.com', port=443) at 0x7ff
  CO  KeyError: 'CO Notifications'
  FL  IndexError: list index out of range
  GA  ConnectTimeout: HTTPSConnectionPool(host='www.tcsg.edu', port=443): Max retries exceeded with url: /warn-public-view/entry/83061/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.tcsg.edu', port=443) at 0x7f
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#593d35302b772e362b323f362b3a3c773d3c2f3c3536291931382e383030773e362f': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#593d35302b772e
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site addresses'
  NE  ConnectTimeout: HTTPSConnectionPool(host='dol.nebraska.gov', port=443): Max retries exceeded with url: /ReemploymentServices/LayoffServices/LayoffsAndDownsizingWARN (Caused by ConnectTimeoutError(<HTTPSConnection(hos
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 29 feeds to /home/runner/work/_temp/warn/warn_feeds.json
