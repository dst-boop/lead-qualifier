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
<function system at 0x7f99d2c68f40> found
scrape_state verify: True
Site init SSL verification status: True
scraped 31 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  FL  IndexError: list index out of range
  GA  ConnectTimeout: HTTPSConnectionPool(host='www.tcsg.edu', port=443): Max retries exceeded with url: /warn-public-view/entry/83061/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.tcsg.edu', port=443) at 0x7f
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#b3d7dfdac19dc4dcc1d8d5dcc1d0d69dd7d6c5d6dfdcc3f3dbd2c4d2dada9dd4dcc5': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#b3d7dfdac19dc4
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site addresses'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 31 feeds to /home/runner/work/_temp/warn/warn_feeds.json
