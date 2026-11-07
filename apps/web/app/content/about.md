Open Langford is an independent project by a group of Langford residents. Its goal is to make Langford's council meetings searchable, easier to follow, and helps make it easier to hold our city's representatives accountable.

We made this site as a fork of Kyle Peatt's [View Royal AI](https://viewroyal.ai/about) project, we found it hard to keep up with council meetings, procedures, and what was really going on. We wanted a tool that made it easier to understand council decisions, elected officials' track records, and helped everyone look up city information using natural language.

> **New to council meetings?** [How council works](/how-council-works) explains readings, motions, carried, in camera and the other words in the minutes, in plain language.

## How it works

- **Automated scraping:** Regularly checks the Langford website for new agendas, minutes, and bylaws.
- **Meeting analysis:** Agenda and minutes files are parsed to extract information and run through AI models to generate summaries and insights. The pipeline currently defaults to OpenAI's `gpt-6-luna`. This helps identify key topics, decisions, and participation in meetings. The results are stored in a database for future reference.
- **Transcription:** For meetings with video, the pipeline downloads the audio and transcribes it using local models on our Mac. Some checks also use OpenAI's transcription API.
- **AI diarization:** Local Mac-based models separate speakers in meeting audio. AI-assisted speaker matching and manual checks help identify who's speaking, but speaker labels can still be wrong or remain unidentified.
- **Vector search:** Agenda items, their associated discussions, motions, and other records are embedded for semantic search, so you can look up information by meaning rather than just matching keywords. Coverage depends on what's been processed.

This is not an official City of Langford service, and the City's own records should be considered the source of truth.

## FAQ

### Is this site a political statement?

Absolutely not. Open Langford is intended as a tool to make city decisions more transparent and accountable. It tries to be as neutral as possible, presenting facts, data, and other information based on what is said and done by the city.

The project is also open source. All of the code, including the instructions we give the AI models to write summaries, is [public on GitHub](https://github.com/ow/openlangford), so anyone can check how the site works and what it's told to do.

### Can I trust the accuracy of the data?

We've done our best to improve the accuracy of the data through AI-assisted processing, cross-checks, and manual checks of selected records. That doesn't mean every meeting, transcript, summary, or speaker identity has been independently reviewed or manually verified. Coverage is still incomplete, and summaries can miss context or get details wrong.

Regardless, AI is not magic, and makes mistakes—just like humans. Check the City's original records for anything you're relying on. If you find errors, mistakes, or something that's outright wrong, [let us know](/contact).

### Why doesn't the site go back further?

The site starts in 2008 because that's as far back as the City publishes council meetings online. Earlier agendas, minutes, and videos aren't available on the City's website, and it's unclear whether the City still has them all.

If you have older agendas, minutes, or meeting videos, or want to request them through a freedom of information (FOI) request so we can publish them, [let us know](/contact).

### What is the data used for?

The data is used to help understand the council's activities and decisions. It can be used to analyze trends, identify patterns, and make informed decisions about the future of the community. This project will never have advertising, and does not sell or use your viewing habits for marketing. You can read more in the [privacy policy](/privacy) and [terms of use](/terms).

### Who is paying for this?

Just us. We've paid for processing through OpenAI and Gemini, and used our local Mac to crunch the data. If you want to support the project in some way, [reach out](/contact).
