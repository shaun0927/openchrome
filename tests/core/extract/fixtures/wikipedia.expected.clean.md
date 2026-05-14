# Web scraping

Web scraping, web harvesting, or web data extraction is [data scraping](https://en.wikipedia.org/wiki/Data_scraping) used for extracting data from websites.

## Techniques

Web scraping is the process of automatically mining data or collecting information from the World Wide Web.

### Human copy-and-paste

Sometimes even the best web-scraping technology cannot replace a human's manual examination and copy-and-paste.

### Text pattern matching

A simple yet powerful approach to extract information from web pages can be based on the UNIX `grep` command.

```
curl https://example.com | grep -o "<title>.*</title>"
```

## Comparison table

| Method | Speed | Cost |
| --- | --- | --- |
| Manual | Slow | High |
| Automated | Fast | Low |

## See also

-   [Data mining](https://en.wikipedia.org/wiki/Data_mining)
-   [Web crawler](https://en.wikipedia.org/wiki/Web_crawler)