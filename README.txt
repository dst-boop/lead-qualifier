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
<function system at 0x7fb74ff56520> found
scrape_state verify: True
Site init SSL verification status: True
scraped 30 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  DC  MissingSchema: Invalid URL '/page/rapid-response': No scheme supplied. Perhaps you meant https:///page/rapid-response?
  FL  IndexError: list index out of range
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#43272f2a316d342c3128252c3120266d272635262f2c33032b2234222a2a6d242c35': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#43272f2a316d34
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  LA  TypeError: write() argument must be str, not None
  MI  KeyError: 'Site address'
  NM  ValueError: scraper produced an empty file
  OH  ValueError: Could not find JSON data div
  RI  UnboundLocalError: cannot access local variable 'headers' where it is not associated with a value
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 30 feeds to /home/runner/work/_temp/warn/warn_feeds.json
