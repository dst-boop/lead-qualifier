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
<function system at 0x7fe928e7c860> found
scrape_state verify: True
Site init SSL verification status: True
scraped 31 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  DC  MissingSchema: Invalid URL '/page/rapid-response': No scheme supplied. Perhaps you meant https:///page/rapid-response?
  FL  IndexError: list index out of range
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#5f3b33362d7128302d3439302d3c3a713b3a293a33302f1f373e283e363671383029': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#5f3b33362d7128
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site address'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 31 feeds to /home/runner/work/_temp/warn/warn_feeds.json
