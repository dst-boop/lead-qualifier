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
<function system at 0x7f7de923a160> found
scrape_state verify: True
Site init SSL verification status: True
scraped 30 of 41 jurisdictions

failed, and left alone rather than retried into a ban:
  CO  KeyError: 'CO Notifications'
  FL  IndexError: list index out of range
  GA  ConnectTimeout: HTTPSConnectionPool(host='www.tcsg.edu', port=443): Max retries exceeded with url: /warn-public-view/entry/82923/ (Caused by ConnectTimeoutError(<HTTPSConnection(host='www.tcsg.edu', port=443) at 0x7f
  HI  MissingSchema: Invalid URL '/cdn-cgi/l/email-protection#9cf8f0f5eeb2ebf3eef7faf3eefff9b2f8f9eaf9f0f3ecdcf4fdebfdf5f5b2fbf3ea': No scheme supplied. Perhaps you meant https:///cdn-cgi/l/email-protection#9cf8f0f5eeb2eb
  ID  PdfminerException: No /Root object! - Is this really a PDF?
  KY  ModuleNotFoundError: No module named 'pyquery'
  LA  TypeError: write() argument must be str, not None
  MI  ModuleNotFoundError: No module named 'pyquery'
  NM  ValueError: scraper produced an empty file
  OH  FeatureNotFound: Couldn't find a tree builder with the features you requested: lxml. Do you need to install a parser library?
  TX  Exception: Scraper isn't scraping.

no scraper exists for these, so they are not covered at all:
  AR MA MN MS NC ND NH NV WV WY

wrote 30 feeds to /home/runner/work/_temp/warn/warn_feeds.json
